//! Gradient fills for rect, circle and path leaves.
//!
//! tiny-skia interpolates stop colours directly in the encoded sRGB values of its 8-bit
//! surface, while the engine composites in linear light. By default a gradient therefore
//! interpolates in linear light, premultiplied by alpha, and is encoded to the sRGB
//! working buffer exactly once. tiny-skia still paints every pixel (anti-aliasing, clip
//! masks, transforms and leaf opacity behave as for flat fills): each user segment is
//! replaced by extra intermediate stops computed in linear light and converted to sRGB,
//! and tiny-skia interpolates sRGB linearly between those dense stops.
//!
//! Error bound: a segment is bisected until the chord between its stops differs from the
//! true linear-light colour at the segment midpoint by at most `TOLERANCE` (0.25) 8-bit
//! levels in alpha and in every premultiplied channel (at most `MAX_DEPTH` halvings).
//! The curve is smooth and monotone per channel, so the error away from the tested
//! midpoints stays within about the same bound, well under the +-0.5 level of the single
//! 8-bit quantisation. `space: "srgb"` skips the expansion and hands the stops to
//! tiny-skia as authored, which matches CSS and canvas gradients.
//!
//! `web/gradient.js` runs the same algorithm for the browser backend; keep both in step.
use super::{color, encoded, linear};
use anyhow::{bail, Context, Result};
use serde_json::Value;
use tiny_skia::{
    Color, GradientStop, LinearGradient, Paint, Point, RadialGradient, SpreadMode, Transform,
};

type Rgba = [f32; 4];

const TOLERANCE: f32 = 0.25;
const MAX_DEPTH: u32 = 10;
/// Shared descriptor limits, mirrored by web/gradient.js.
const MAX_AUTHORED_STOPS: usize = 4096;
const MAX_EXPANDED_STOPS: usize = 65_536;
/// Coordinates must stay representable in the native f32 geometry and are restricted
/// to the same domain in the browser to keep descriptor validation identical.
const MAX_COORDINATE: f64 = f32::MAX as f64;

#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Space {
    Linear,
    Srgb,
}

enum Shape {
    Linear { from: Point, to: Point },
    Radial { center: Point, radius: f32 },
}

pub(super) struct Spec {
    shape: Shape,
    space: Space,
    stops: Vec<(f32, Rgba)>,
}

fn number(fill: &Value, key: &str, what: &str) -> Result<f32> {
    match fill[key].as_f64() {
        Some(x) if x.is_finite() && x.abs() <= MAX_COORDINATE && (x as f32).is_finite() => {
            Ok(x as f32)
        }
        _ => bail!("{what} {key} must be a finite number"),
    }
}

fn parse_stops(fill: &Value) -> Result<Vec<(f32, Rgba)>> {
    let values = fill["stops"]
        .as_array()
        .context("gradient stops must be an array")?;
    if values.len() < 2 {
        bail!("gradient needs at least two stops");
    }
    if values.len() > MAX_AUTHORED_STOPS {
        bail!("gradient authored stops exceed maximum of {MAX_AUTHORED_STOPS}");
    }
    let mut previous = 0.0f64;
    let mut stops = Vec::with_capacity(values.len());
    for (i, stop) in values.iter().enumerate() {
        let offset = match stop["offset"].as_f64() {
            Some(x) if (0.0..=1.0).contains(&x) => x,
            _ => bail!("gradient stop {i} offset must be a number in [0, 1]"),
        };
        if offset < previous {
            bail!("gradient stop offsets must not decrease (stop {i})");
        }
        previous = offset;
        let text = stop["color"]
            .as_str()
            .with_context(|| format!("gradient stop {i} needs a colour string"))?;
        let digits = text.strip_prefix('#').unwrap_or("");
        if !matches!(digits.len(), 6 | 8) || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("gradient stop {i} colour must be #RRGGBB or #RRGGBBAA");
        }
        let c = color(text)?;
        stops.push((offset as f32, c.map(|v| v as f32 / 255.)));
    }
    Ok(stops)
}

pub(super) fn parse(fill: &Value) -> Result<Spec> {
    let kind = fill["type"].as_str().unwrap_or("undefined");
    let shape = match kind {
        "linear" => {
            let (x1, y1) = (
                number(fill, "x1", "linear gradient")?,
                number(fill, "y1", "linear gradient")?,
            );
            let (x2, y2) = (
                number(fill, "x2", "linear gradient")?,
                number(fill, "y2", "linear gradient")?,
            );
            if x1 == x2 && y1 == y2 {
                bail!("linear gradient needs two distinct endpoints");
            }
            Shape::Linear {
                from: Point::from_xy(x1, y1),
                to: Point::from_xy(x2, y2),
            }
        }
        "radial" => {
            let (cx, cy) = (
                number(fill, "cx", "radial gradient")?,
                number(fill, "cy", "radial gradient")?,
            );
            let r = number(fill, "r", "radial gradient")?;
            if r <= 0.0 {
                bail!("radial gradient radius must be greater than 0");
            }
            Shape::Radial {
                center: Point::from_xy(cx, cy),
                radius: r,
            }
        }
        other => bail!("unsupported fill descriptor type: {other}"),
    };
    let space = match fill["space"].as_str() {
        None if fill["space"].is_null() => Space::Linear,
        Some("linear") => Space::Linear,
        Some("srgb") => Space::Srgb,
        _ => bail!("gradient space must be \"linear\" or \"srgb\""),
    };
    Ok(Spec {
        shape,
        space,
        stops: parse_stops(fill)?,
    })
}

/// One user segment between two stops, evaluated premultiplied in the chosen space.
struct Segment {
    c0: Rgba,
    c1: Rgba,
    space: Space,
    v0: [f32; 3],
    v1: [f32; 3],
}

impl Segment {
    fn new(mut c0: Rgba, mut c1: Rgba, space: Space) -> Self {
        // A fully transparent stop has no colour of its own; borrowing its neighbour's
        // keeps the final chord from fading through gray.
        if c0[3] == 0. && c1[3] > 0. {
            c0[..3].copy_from_slice(&c1[..3]);
        } else if c1[3] == 0. && c0[3] > 0. {
            c1[..3].copy_from_slice(&c0[..3]);
        }
        let decode = |c: Rgba| match space {
            Space::Linear => [linear(c[0]), linear(c[1]), linear(c[2])],
            Space::Srgb => [c[0], c[1], c[2]],
        };
        Self {
            c0,
            c1,
            space,
            v0: decode(c0),
            v1: decode(c1),
        }
    }

    /// Straight (unpremultiplied) sRGB colour at `u` in 0..=1. Interpolating
    /// premultiplied makes a transparent stop's colour irrelevant, so fading to
    /// transparent black leaves no dark fringe (this is also how CSS defines gradients).
    fn at(&self, u: f32) -> Rgba {
        let lerp = |a: f32, b: f32| a + (b - a) * u;
        let alpha = lerp(self.c0[3], self.c1[3]);
        let channel = |i: usize| {
            let value = if alpha > 0. {
                lerp(self.v0[i] * self.c0[3], self.v1[i] * self.c1[3]) / alpha
            } else {
                lerp(self.v0[i], self.v1[i])
            };
            match self.space {
                Space::Linear => encoded(value),
                Space::Srgb => value.clamp(0., 1.),
            }
        };
        [channel(0), channel(1), channel(2), alpha]
    }

    fn subdivide(
        &self,
        (o0, o1): (f32, f32),
        (u0, u1): (f32, f32),
        (c0, c1): (Rgba, Rgba),
        depth: u32,
        out: &mut Vec<(f32, Rgba)>,
    ) -> Result<()> {
        let um = (u0 + u1) / 2.;
        let cm = self.at(um);
        if depth >= MAX_DEPTH || chord_error(cm, c0, c1) <= TOLERANCE {
            return Ok(());
        }
        self.subdivide((o0, o1), (u0, um), (c0, cm), depth + 1, out)?;
        if out.len() >= MAX_EXPANDED_STOPS {
            bail!("gradient expanded stops exceed maximum of {MAX_EXPANDED_STOPS}");
        }
        out.push((o0 + (o1 - o0) * um, cm));
        self.subdivide((o0, o1), (um, u1), (cm, c1), depth + 1, out)?;
        Ok(())
    }
}

/// Largest difference, in 8-bit levels, between the true colour `mid` and what tiny-skia
/// produces halfway along the chord from `c0` to `c1` (alpha and premultiplied channels).
fn chord_error(mid: Rgba, c0: Rgba, c1: Rgba) -> f32 {
    let alpha = (c0[3] + c1[3]) / 2.;
    let mut worst = (mid[3] - alpha).abs();
    for i in 0..3 {
        let chord = (c0[i] + c1[i]) / 2. * alpha;
        worst = worst.max((mid[i] * mid[3] - chord).abs());
    }
    worst * 255.
}

/// The stops tiny-skia should interpolate straight in sRGB so the result follows
/// `space` with premultiplied alpha. Opaque sRGB stops come back unchanged.
pub(super) fn expand(stops: &[(f32, Rgba)], space: Space) -> Result<Vec<(f32, Rgba)>> {
    let mut out: Vec<(f32, Rgba)> = Vec::new();
    let push = |out: &mut Vec<(f32, Rgba)>, stop: (f32, Rgba)| {
        if out.last() != Some(&stop) {
            if out.len() >= MAX_EXPANDED_STOPS {
                bail!("gradient expanded stops exceed maximum of {MAX_EXPANDED_STOPS}");
            }
            out.push(stop);
        }
        Ok(())
    };
    for pair in stops.windows(2) {
        let ((o0, c0), (o1, c1)) = (pair[0], pair[1]);
        let segment = Segment::new(c0, c1, space);
        push(&mut out, (o0, segment.c0))?;
        if o1 > o0 && segment.c0 != segment.c1 {
            segment.subdivide((o0, o1), (0., 1.), (segment.c0, segment.c1), 0, &mut out)?;
        }
        push(&mut out, (o1, segment.c1))?;
    }
    Ok(out)
}

impl Spec {
    fn paint(&self) -> Result<Paint<'static>> {
        let mut stops = Vec::new();
        for (offset, c) in expand(&self.stops, self.space)? {
            let c = Color::from_rgba(
                c[0].clamp(0., 1.),
                c[1].clamp(0., 1.),
                c[2].clamp(0., 1.),
                c[3].clamp(0., 1.),
            )
            .context("gradient stop colour")?;
            stops.push(GradientStop::new(offset, c));
        }
        // The leaf transform is applied by the fill call, so the shader stays in local space.
        let identity = Transform::identity();
        let shader = match self.shape {
            Shape::Linear { from, to } => {
                LinearGradient::new(from, to, stops, SpreadMode::Pad, identity)
                    .context("linear gradient")?
            }
            Shape::Radial { center, radius } => {
                RadialGradient::new(center, center, radius, stops, SpreadMode::Pad, identity)
                    .context("radial gradient")?
            }
        };
        Ok(Paint {
            shader,
            ..Paint::default()
        })
    }
}

/// The paint for a leaf's `fill` (a colour string or a gradient descriptor), or None when
/// the leaf has no `fill` and uses its flat `color`.
pub(super) fn paint(n: &Value) -> Result<Option<Paint<'static>>> {
    match &n["fill"] {
        Value::Null => Ok(None),
        Value::String(text) => {
            let rgba = color(text)?;
            let mut paint = Paint::default();
            paint.set_color_rgba8(rgba[0], rgba[1], rgba[2], rgba[3]);
            Ok(Some(paint))
        }
        fill @ Value::Object(_) => Ok(Some(parse(fill)?.paint()?)),
        _ => bail!("fill must be a colour string or a gradient descriptor"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bw(space: &str) -> Value {
        json!({"type":"linear","x1":0,"y1":0,"x2":10,"y2":0,"space":space,
            "stops":[{"offset":0,"color":"#000000"},{"offset":1,"color":"#ffffff"}]})
    }

    fn err(fill: Value) -> String {
        match parse(&fill) {
            Ok(_) => "accepted".into(),
            Err(e) => format!("{e:#}"),
        }
    }

    /// Straight sRGB colour a tiny-skia chord through `dense` yields at `t`.
    fn chord(dense: &[(f32, Rgba)], t: f32) -> Rgba {
        let i = dense.iter().rposition(|s| s.0 <= t).unwrap();
        let (a, b) = (dense[i], dense[(i + 1).min(dense.len() - 1)]);
        let w = if b.0 > a.0 {
            (t - a.0) / (b.0 - a.0)
        } else {
            0.
        };
        std::array::from_fn(|c| a.1[c] + (b.1[c] - a.1[c]) * w)
    }

    #[test]
    fn opaque_srgb_stops_pass_through() {
        let spec = parse(&bw("srgb")).unwrap();
        assert_eq!(expand(&spec.stops, spec.space).unwrap(), spec.stops);
    }

    #[test]
    fn linear_midpoint_is_the_linear_light_value() {
        let spec = parse(&bw("linear")).unwrap();
        assert_eq!(spec.space, Space::Linear);
        let dense = expand(&spec.stops, spec.space).unwrap();
        let mid = chord(&dense, 0.5);
        // 0.5 in linear light encodes to 0.7354 (sRGB 187.5), not the 0.5 of sRGB mixing.
        assert!((mid[0] * 255. - 187.5).abs() < 0.3, "{}", mid[0] * 255.);
        assert!(dense.len() > 8 && dense.len() < 200, "{}", dense.len());
        assert_eq!(dense[0], (0., [0., 0., 0., 1.]));
        assert_eq!(*dense.last().unwrap(), (1., [1., 1., 1., 1.]));
    }

    #[test]
    fn default_space_is_linear_and_bad_space_is_rejected() {
        let mut fill = bw("linear");
        fill.as_object_mut().unwrap().remove("space");
        assert_eq!(parse(&fill).unwrap().space, Space::Linear);
        assert_eq!(
            err(bw("hsl")),
            "gradient space must be \"linear\" or \"srgb\""
        );
    }

    #[test]
    fn dense_stops_stay_within_the_stated_bound() {
        let cases = [
            ("#000000", "#ffffff"),
            ("#ff0000", "#0000ff"),
            ("#102040", "#80c0ff"),
            ("#ffffffff", "#ffffff00"),
            ("#ffffffff", "#00000000"),
            ("#ff000080", "#00ff00ff"),
        ];
        for (a, b) in cases {
            let c = |s: &str| color(s).unwrap().map(|v| v as f32 / 255.);
            let stops = [(0., c(a)), (1., c(b))];
            let dense = expand(&stops, Space::Linear).unwrap();
            let segment = Segment::new(stops[0].1, stops[1].1, Space::Linear);
            let mut worst = 0f32;
            for k in 0..=4000 {
                let t = k as f32 / 4000.;
                let (m, c) = (segment.at(t), chord(&dense, t));
                let channel = (0..3)
                    .map(|i| (m[i] * m[3] - c[i] * c[3]).abs())
                    .fold((m[3] - c[3]).abs(), f32::max);
                worst = worst.max(channel * 255.);
            }
            assert!(
                worst < 0.4,
                "{a} to {b}: {worst} levels over {} stops",
                dense.len()
            );
        }
    }

    #[test]
    fn transparent_stops_leave_no_dark_fringe() {
        let stops = [(0., [1., 1., 1., 1.]), (1., [0., 0., 0., 0.])];
        for space in [Space::Linear, Space::Srgb] {
            let dense = expand(&stops, space).unwrap();
            assert_eq!(dense.len(), 2, "{space:?}");
            for (_, c) in &dense {
                assert!(c[..3].iter().all(|v| *v == 1.), "{space:?} {c:?}");
            }
            assert_eq!(dense[1].1[3], 0.);
        }
    }

    #[test]
    fn hard_stops_are_preserved() {
        let red = [1., 0., 0., 1.];
        let blue = [0., 0., 1., 1.];
        let dense = expand(
            &[(0., red), (0.5, red), (0.5, blue), (1., blue)],
            Space::Linear,
        )
        .unwrap();
        assert_eq!(dense, vec![(0., red), (0.5, red), (0.5, blue), (1., blue)]);
    }

    #[test]
    fn aggregate_expansion_budget_is_checked_during_expansion() {
        let black = [0., 0., 0., 1.];
        let white = [1., 1., 1., 1.];
        let stops = (0..=4095)
            .map(|i| (i as f32 / 4095., if i % 2 == 0 { black } else { white }))
            .collect::<Vec<_>>();
        let error = expand(&stops, Space::Linear).unwrap_err();
        assert_eq!(
            format!("{error:#}"),
            "gradient expanded stops exceed maximum of 65536"
        );
    }

    #[test]
    fn invalid_descriptors_report_what_is_wrong() {
        let stops = json!([{"offset":0,"color":"#000000"},{"offset":1,"color":"#ffffff"}]);
        let linear = |extra: Value| {
            let mut v = json!({"type":"linear","x1":0,"y1":0,"x2":10,"y2":0,"stops":stops});
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            v
        };
        assert_eq!(
            err(linear(json!({"stops":[{"offset":0,"color":"#000000"}]}))),
            "gradient needs at least two stops"
        );
        assert_eq!(
            err(linear(
                json!({"stops":[{"offset":0.6,"color":"#000000"},{"offset":0.2,"color":"#ffffff"}]})
            )),
            "gradient stop offsets must not decrease (stop 1)"
        );
        assert_eq!(
            err(linear(
                json!({"stops":[{"offset":0.50000001,"color":"#000000"},{"offset":0.5,"color":"#ffffff"}]})
            )),
            "gradient stop offsets must not decrease (stop 1)"
        );
        let too_many = (0..=MAX_AUTHORED_STOPS)
            .map(|i| json!({"offset": i as f64 / MAX_AUTHORED_STOPS as f64, "color":"#000000"}))
            .collect::<Vec<_>>();
        assert_eq!(
            err(linear(json!({"stops":too_many}))),
            "gradient authored stops exceed maximum of 4096"
        );
        assert_eq!(
            err(linear(
                json!({"stops":[{"offset":0,"color":"#000000"},{"offset":1.5,"color":"#ffffff"}]})
            )),
            "gradient stop 1 offset must be a number in [0, 1]"
        );
        assert_eq!(
            err(linear(json!({"x2":null}))),
            "linear gradient x2 must be a finite number"
        );
        assert_eq!(
            err(linear(json!({"x2":1e40}))),
            "linear gradient x2 must be a finite number"
        );
        assert_eq!(
            err(linear(json!({"x2":0}))),
            "linear gradient needs two distinct endpoints"
        );
        assert_eq!(
            err(json!({"type":"radial","cx":0,"cy":0,"r":0,"stops":stops})),
            "radial gradient radius must be greater than 0"
        );
        assert_eq!(
            err(json!({"type":"conic","stops":stops})),
            "unsupported fill descriptor type: conic"
        );
        assert_eq!(
            err(linear(
                json!({"stops":[{"offset":0,"color":"red"},{"offset":1,"color":"#ffffff"}]})
            )),
            "gradient stop 0 colour must be #RRGGBB or #RRGGBBAA"
        );
        assert!(paint(&json!({"fill": 3})).is_err());
        assert!(paint(&json!({"color":"#ffffff"})).unwrap().is_none());
    }
}
