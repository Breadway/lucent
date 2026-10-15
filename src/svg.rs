//! SVG documents as a scene-graph leaf: the markup is parsed and rasterised by resvg, then
//! blended like any other leaf. Used to run DOM/SVG authored films (the Astra framework)
//! natively, with the SVG tree produced by the film's own TypeScript/JavaScript in QuickJS.
use anyhow::{bail, Context, Result};
use resvg::{tiny_skia as sk, usvg};
use serde_json::Value;
use std::{fs, path::Path, sync::Arc};
use usvg::fontdb;

/// Shared by the rasteriser and by the `__measure_text` binding exposed to film scripts, so
/// scripts lay text out with the same faces and shaper that later draw it.
pub(crate) type FontDb = Arc<fontdb::Database>;

pub(crate) fn load_fonts(root: &Path, manifest: &Value) -> Result<FontDb> {
    let mut db = fontdb::Database::new();
    for font in manifest["fonts"].as_array().into_iter().flatten() {
        let file = font["file"].as_str().context("font file")?;
        let path = root.join(file).canonicalize()?;
        if !path.starts_with(root) {
            bail!("Asset escapes project: {file}");
        }
        db.load_font_data(fs::read(path)?);
    }
    Ok(Arc::new(db))
}

/// Advance width of `text` in CSS pixels, as `SVGTextContentElement.getComputedTextLength`
/// reports it: shaped advances at `size`, plus `letter_spacing` after every character.
pub(crate) fn measure_text(
    db: &fontdb::Database,
    text: &str,
    family: &str,
    weight: u16,
    size: f32,
    letter_spacing: f32,
) -> f32 {
    let query = fontdb::Query {
        families: &[fontdb::Family::Name(family)],
        weight: fontdb::Weight(weight),
        stretch: fontdb::Stretch::Normal,
        style: fontdb::Style::Normal,
    };
    let Some(id) = db.query(&query) else {
        return 0.;
    };
    let advance = db
        .with_face_data(id, |data, index| {
            let mut face = rustybuzz::Face::from_slice(data, index)?;
            // Variable faces: advances depend on the weight axis, exactly as when drawn.
            if face.is_variable() {
                face.set_variation(
                    rustybuzz::ttf_parser::Tag::from_bytes(b"wght"),
                    weight as f32,
                );
            }
            let mut buffer = rustybuzz::UnicodeBuffer::new();
            buffer.push_str(text);
            let shaped = rustybuzz::shape(&face, &[], buffer);
            let units: i32 = shaped.glyph_positions().iter().map(|p| p.x_advance).sum();
            Some(units as f32 * size / face.units_per_em() as f32)
        })
        .flatten()
        .unwrap_or(0.);
    advance + letter_spacing * text.chars().count() as f32
}

/// Whether the best face for `family` has a glyph for `code`. Scripts use this to split text
/// that the renderer would otherwise reshape wholesale in a fallback font once any one glyph
/// of a run is missing from the primary font.
pub(crate) fn has_glyph(db: &fontdb::Database, family: &str, code: u32) -> bool {
    let query = fontdb::Query {
        families: &[fontdb::Family::Name(family)],
        weight: fontdb::Weight::NORMAL,
        stretch: fontdb::Stretch::Normal,
        style: fontdb::Style::Normal,
    };
    let (Some(id), Some(ch)) = (db.query(&query), char::from_u32(code)) else {
        return false;
    };
    db.with_face_data(id, |data, index| {
        rustybuzz::Face::from_slice(data, index).is_some_and(|f| f.glyph_index(ch).is_some())
    })
    .unwrap_or(false)
}

pub(crate) struct Svg {
    options: usvg::Options<'static>,
    /// Frame-sized scratch surface, cleared before every document.
    pixmap: Option<sk::Pixmap>,
}

impl Svg {
    pub(crate) fn new(fonts: FontDb, default_family: &str) -> Self {
        let options = usvg::Options {
            fontdb: fonts,
            font_family: default_family.to_owned(),
            ..Default::default()
        };
        Self {
            options,
            pixmap: None,
        }
    }

    /// Rasterise `markup` into a `width` x `height` surface with `transform` as the root
    /// transform (design space to pixels). Returns premultiplied sRGB RGBA8.
    pub(crate) fn render(
        &mut self,
        markup: &str,
        transform: sk::Transform,
        width: u32,
        height: u32,
        grain: Option<&Value>,
    ) -> Result<&[u8]> {
        let tree = usvg::Tree::from_str(markup, &self.options)
            .map_err(|e| anyhow::anyhow!("Invalid SVG document: {e}"))?;
        let pixmap = match &mut self.pixmap {
            Some(p) if p.width() == width && p.height() == height => p,
            slot => slot.insert(sk::Pixmap::new(width, height).context("svg surface")?),
        };
        pixmap.fill(sk::Color::TRANSPARENT);
        resvg::render(&tree, transform, &mut pixmap.as_mut());
        if let Some(grain) = grain {
            overlay_grain(pixmap, grain);
        }
        Ok(self.pixmap.as_ref().unwrap().data())
    }
}

/// Film grain: a small noise canvas, scaled up without smoothing and blended with the
/// `overlay` mode at low opacity. The noise is a pure function of the seed, so frames
/// stay reproducible. Expects an opaque surface.
fn overlay_grain(pixmap: &mut sk::Pixmap, grain: &Value) {
    let seed = (grain["seed"].as_i64().unwrap_or(0) as i32)
        .wrapping_add(grain["frame"].as_i64().unwrap_or(0) as i32);
    let opacity = grain["opacity"].as_f64().unwrap_or(0.055) as f32;
    let (gw, gh) = (
        grain["width"].as_u64().unwrap_or(320) as usize,
        grain["height"].as_u64().unwrap_or(180) as usize,
    );
    let (w, h) = (pixmap.width() as usize, pixmap.height() as usize);
    // Same hash as the original canvas version: Math.imul(i + seed, 2654435761) >>> 24.
    let noise: Vec<u8> = (0..gw * gh)
        .map(|i| {
            let v = (i as i32)
                .wrapping_add(seed)
                .wrapping_mul(0x9E37_79B1_u32 as i32);
            ((v as u32) >> 24) as u8
        })
        .collect();
    // Overlay of backdrop d and noise s, mixed in at `opacity`: both are 8-bit, so tabulate.
    let blend: Vec<u8> = (0..65536usize)
        .map(|i| {
            let (d, s) = ((i >> 8) as f32 / 255., (i & 255) as f32 / 255.);
            let o = if d <= 0.5 {
                2. * d * s
            } else {
                1. - 2. * (1. - d) * (1. - s)
            };
            ((d + (o - d) * opacity) * 255.).round().clamp(0., 255.) as u8
        })
        .collect();
    let columns: Vec<usize> = (0..w).map(|x| x * gw / w).collect();
    let data = pixmap.data_mut();
    for y in 0..h {
        let row = &noise[(y * gh / h) * gw..][..gw];
        for (x, px) in data[y * w * 4..][..w * 4].chunks_exact_mut(4).enumerate() {
            let s = row[columns[x]] as usize;
            for c in &mut px[..3] {
                *c = blend[(*c as usize) << 8 | s];
            }
        }
    }
}

/// `lucent svg-render file.svg manifest.json out.png`: parse and rasterise one document at its
/// own size, printing the time of each step.
pub(crate) fn render_file(svg: &str, manifest: &str, out: &str) -> Result<()> {
    use std::time::Instant;
    let manifest_path = Path::new(manifest).canonicalize()?;
    let root = manifest_path.parent().context("project root")?;
    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    let fonts = load_fonts(root, &manifest)?;
    if std::env::var_os("LUCENT_FONT_LIST").is_some() {
        for face in fonts.faces() {
            println!(
                "face {:?} weight {} stretch {:?} style {:?} variable-source {:?}",
                face.families
                    .iter()
                    .map(|f| f.0.as_str())
                    .collect::<Vec<_>>(),
                face.weight.0,
                face.stretch,
                face.style,
                face.post_script_name
            );
        }
    }
    let renderer = Svg::new(fonts, "Inter");
    let markup = fs::read_to_string(svg)?;
    let (width, height) = (1920, 1080);
    let start = Instant::now();
    let tree = usvg::Tree::from_str(&markup, &renderer.options)
        .map_err(|e| anyhow::anyhow!("Invalid SVG document: {e}"))?;
    let parsed = start.elapsed();
    let mut pixmap = sk::Pixmap::new(width, height).context("surface")?;
    resvg::render(&tree, sk::Transform::identity(), &mut pixmap.as_mut());
    println!(
        "parse {parsed:.1?}, render {:.1?}",
        start.elapsed() - parsed
    );
    pixmap.save_png(out)?;
    Ok(())
}
