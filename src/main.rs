mod native;
mod svg;
mod viewer;
use anyhow::{bail, Context, Result};
use half::f16;
use std::{
    env,
    io::{self, Read, Write},
    path::Path,
    process::Command,
};

// A typed, versioned boundary between browser capture and native encoding.
fn normalize_frame(file: &str) -> Result<()> {
    let rgba = image::open(file)?.into_rgba8();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for p in rgba.pixels() {
        let a = p[3] as f32 / 255.0;
        for c in &p.0[..3] {
            let s = *c as f32 / 255.0;
            let l = if s <= 0.04045 {
                s / 12.92
            } else {
                ((s + 0.055) / 1.055).powf(2.4)
            };
            stdout.write_all(&f16::from_f32(l * a).to_le_bytes())?;
        }
        stdout.write_all(&f16::from_f32(a).to_le_bytes())?;
    }
    Ok(())
}
fn main() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("native-viewer") => viewer::play(
            args.get(1).context("bundle")?,
            args.get(2).context("manifest")?,
        ),
        Some("preview-bench") => viewer::preview_bench(
            args.get(1).context("bundle")?,
            args.get(2).context("manifest")?,
            args.get(3).map_or(Ok(120), |s| s.parse().context("frames"))?,
            args.get(4).map_or(Ok(1920), |s| s.parse().context("width"))?,
            args.get(5).map_or(Ok(1080), |s| s.parse().context("height"))?,
        ),
        Some("play") => {
            let file = args.get(1).context("video path")?;
            let status = Command::new("ffplay").args(["-autoexit", file]).status()?;
            if !status.success() {
                bail!("native video playback failed");
            }
            Ok(())
        }
        Some("native-capabilities") => native::capabilities(),
        // Debug aid: rasterise an SVG file with a project's fonts and report the time.
        Some("svg-render") => svg::render_file(
            args.get(1).context("svg file")?,
            args.get(2).context("manifest")?,
            args.get(3).context("output png")?,
        ),
        Some("native-server") => native::server(
            args.get(1).context("bundle")?,
            args.get(2).context("manifest")?,
        ),
        Some("frame-stream") => {
            let mut stdin = io::BufReader::new(io::stdin().lock());
            let mut stdout = io::BufWriter::new(io::stdout().lock());
            // The transfer table is process-constant; rebuilding it per
            // frame repeats 131k powf evaluations for identical bytes.
            let mut lut = vec![0u16; 65536];
            for (i, v) in lut.iter_mut().enumerate() {
                let s = i as f32 / 65535.;
                let l = if s <= 0.04045 {
                    s / 12.92
                } else {
                    ((s + 0.055) / 1.055).powf(2.4)
                };
                let l = f16::from_f32(l).to_f32();
                let s = if l <= 0.0031308 {
                    12.92 * l
                } else {
                    1.055 * l.powf(1. / 2.4) - 0.055
                };
                *v = (s * 65535.).round() as u16;
            }
            let mut row: Vec<u8> = Vec::new();
            loop {
                let mut size = [0; 4];
                match stdin.read_exact(&mut size) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
                    Err(e) => return Err(e.into()),
                }
                let size = u32::from_le_bytes(size) as usize;
                if size > 256 * 1024 * 1024 {
                    bail!("frame too large");
                }
                let mut bytes = vec![0; size];
                stdin.read_exact(&mut bytes)?;
                let rgba = image::load_from_memory(&bytes)?.into_rgba16();
                write!(stdout, "P6\n{} {}\n65535\n", rgba.width(), rgba.height())?;
                let w = rgba.width() as usize;
                let samples = rgba.into_raw();
                if row.len() != w * 6 {
                    row.resize(w * 6, 0);
                }
                for stripe in samples.chunks_exact(w * 4) {
                    for (dst, px) in row.chunks_exact_mut(6).zip(stripe.chunks_exact(4)) {
                        if px[3] != 65535 {
                            bail!("encoding frame must already be flattened");
                        }
                        for c in 0..3 {
                            let be = lut[px[c] as usize].to_be_bytes();
                            dst[c * 2] = be[0];
                            dst[c * 2 + 1] = be[1];
                        }
                    }
                    stdout.write_all(&row)?;
                }
                stdout.flush()?;
            }
            Ok(())
        }
        Some("frame-normalize") => normalize_frame(args.get(1).context("expected image path")?),
        Some("frame-describe") => {
            println!(
                "{}",
                serde_json::json!({"schemaVersion":1,"pixelFormat":"rgba16f","primaries":"bt709","transfer":"linear","range":"full","alpha":"premultiplied","origin":"top-left","rowStride":"width*8","endianness":"little"})
            );
            Ok(())
        }
        Some("frame-to-ppm") => {
            let width: usize = args.get(1).context("width")?.parse()?;
            let height: usize = args.get(2).context("height")?.parse()?;
            let mut input = vec![];
            io::stdin().read_to_end(&mut input)?;
            if width.checked_mul(height).and_then(|n| n.checked_mul(8)) != Some(input.len()) {
                bail!("incorrect RGBA16F frame length");
            }
            let mut out = io::BufWriter::new(io::stdout().lock());
            write!(out, "P6\n{width} {height}\n65535\n")?;
            for pixel in input.chunks_exact(8) {
                for i in 0..3 {
                    let v = f16::from_le_bytes([pixel[i * 2], pixel[i * 2 + 1]]).to_f32();
                    if !v.is_finite() {
                        bail!("non-finite pixel");
                    }
                    // Premultiplied RGB over black. Re-encode sRGB for managed ffmpeg conversion.
                    let v = v.clamp(0., 1.);
                    let s = if v <= 0.0031308 {
                        12.92 * v
                    } else {
                        1.055 * v.powf(1. / 2.4) - 0.055
                    };
                    out.write_all(&((s * 65535.).round() as u16).to_be_bytes())?;
                }
            }
            Ok(())
        }
        _ => {
            let cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("cli.mjs");
            let status = Command::new("node")
                .arg(cli)
                .args(&args)
                .status()
                .context("Node.js 22 required for browser orchestration")?;
            std::process::exit(status.code().unwrap_or(1));
        }
    }
}
