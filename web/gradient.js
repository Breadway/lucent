// Gradient fills for the browser backend; mirrors src/native/gradient.rs (keep in step).
// Canvas interpolates stops straight in sRGB. Extra stops computed premultiplied in the
// requested space ("linear" light by default, "srgb" for CSS parity) make the canvas
// blend follow it to within TOLERANCE 8-bit levels. Opaque sRGB stops pass through.
const TOLERANCE = 0.25;
const MAX_DEPTH = 10;
// Keep descriptor and aggregate expansion bounds aligned with native/gradient.rs.
const MAX_AUTHORED_STOPS = 4096;
const MAX_EXPANDED_STOPS = 65536;
const MAX_COORDINATE = 3.4028234663852886e38;
const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encoded = (v) => {
  v = Math.min(1, Math.max(0, v));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

function number(fill, key, what) {
  if (typeof fill[key] !== "number" || !Number.isFinite(fill[key]))
    throw Error(`${what} ${key} must be a finite number`);
  if (Math.abs(fill[key]) > MAX_COORDINATE)
    throw Error(`${what} ${key} must be a finite number`);
  return fill[key];
}

function parseStops(fill) {
  if (!Array.isArray(fill.stops))
    throw Error("gradient stops must be an array");
  if (fill.stops.length < 2) throw Error("gradient needs at least two stops");
  if (fill.stops.length > MAX_AUTHORED_STOPS)
    throw Error(`gradient authored stops exceed maximum of ${MAX_AUTHORED_STOPS}`);
  let previous = 0;
  return fill.stops.map((stop, i) => {
    const offset = stop?.offset;
    if (typeof offset !== "number" || !(offset >= 0 && offset <= 1))
      throw Error(`gradient stop ${i} offset must be a number in [0, 1]`);
    if (offset < previous)
      throw Error(`gradient stop offsets must not decrease (stop ${i})`);
    previous = offset;
    const text = stop.color;
    if (typeof text !== "string")
      throw Error(`gradient stop ${i} needs a colour string`);
    if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(text))
      throw Error(`gradient stop ${i} colour must be #RRGGBB or #RRGGBBAA`);
    const byte = (k) => parseInt(text.slice(1 + k * 2, 3 + k * 2), 16) / 255;
    return [
      offset,
      [byte(0), byte(1), byte(2), text.length === 9 ? byte(3) : 1],
    ];
  });
}

export function parseGradient(fill) {
  let shape;
  if (fill.type === "linear") {
    const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((k) =>
      number(fill, k, "linear gradient"),
    );
    if (x1 === x2 && y1 === y2)
      throw Error("linear gradient needs two distinct endpoints");
    shape = { type: "linear", x1, y1, x2, y2 };
  } else if (fill.type === "radial") {
    const [cx, cy, r] = ["cx", "cy", "r"].map((k) =>
      number(fill, k, "radial gradient"),
    );
    if (r <= 0) throw Error("radial gradient radius must be greater than 0");
    shape = { type: "radial", cx, cy, r };
  } else {
    throw Error(`unsupported fill descriptor type: ${fill.type}`);
  }
  const space = fill.space ?? "linear";
  if (space !== "linear" && space !== "srgb")
    throw Error('gradient space must be "linear" or "srgb"');
  return { shape, space, stops: parseStops(fill) };
}

function segment(a, b, space) {
  // A fully transparent stop borrows its neighbour's colour (see gradient.rs).
  const c0 = [...a];
  const c1 = [...b];
  if (c0[3] === 0 && c1[3] > 0) for (let i = 0; i < 3; i++) c0[i] = c1[i];
  else if (c1[3] === 0 && c0[3] > 0) for (let i = 0; i < 3; i++) c1[i] = c0[i];
  const decode = (c) =>
    space === "linear" ? c.slice(0, 3).map(linear) : c.slice(0, 3);
  const v0 = decode(c0);
  const v1 = decode(c1);
  const at = (u) => {
    const lerp = (x, y) => x + (y - x) * u;
    const alpha = lerp(c0[3], c1[3]);
    const out = [0, 0, 0, alpha];
    for (let i = 0; i < 3; i++) {
      const value =
        alpha > 0
          ? lerp(v0[i] * c0[3], v1[i] * c1[3]) / alpha
          : lerp(v0[i], v1[i]);
      out[i] =
        space === "linear" ? encoded(value) : Math.min(1, Math.max(0, value));
    }
    return out;
  };
  return { c0, c1, at };
}

function chordError(mid, c0, c1) {
  const alpha = (c0[3] + c1[3]) / 2;
  let worst = Math.abs(mid[3] - alpha);
  for (let i = 0; i < 3; i++)
    worst = Math.max(
      worst,
      Math.abs(mid[i] * mid[3] - ((c0[i] + c1[i]) / 2) * alpha),
    );
  return worst * 255;
}

export function expandStops(stops, space) {
  const out = [];
  const same = (a, b) =>
    a && a[0] === b[0] && a[1].every((v, i) => v === b[1][i]);
  const push = (stop) => {
    if (!same(out[out.length - 1], stop)) {
      if (out.length >= MAX_EXPANDED_STOPS)
        throw Error(`gradient expanded stops exceed maximum of ${MAX_EXPANDED_STOPS}`);
      out.push(stop);
    }
  };
  for (let s = 0; s + 1 < stops.length; s++) {
    const [o0, a] = stops[s];
    const [o1, b] = stops[s + 1];
    const seg = segment(a, b, space);
    push([o0, seg.c0]);
    const split = (u0, u1, c0, c1, depth) => {
      const um = (u0 + u1) / 2;
      const cm = seg.at(um);
      if (depth >= MAX_DEPTH || chordError(cm, c0, c1) <= TOLERANCE) return;
      split(u0, um, c0, cm, depth + 1);
      if (out.length >= MAX_EXPANDED_STOPS)
        throw Error(`gradient expanded stops exceed maximum of ${MAX_EXPANDED_STOPS}`);
      out.push([o0 + (o1 - o0) * um, cm]);
      split(um, u1, cm, c1, depth + 1);
    };
    if (o1 > o0 && seg.c0.some((v, i) => v !== seg.c1[i]))
      split(0, 1, seg.c0, seg.c1, 0);
    push([o1, seg.c1]);
  }
  return out;
}

// A canvas fill style for a gradient descriptor, validated like the native engine.
export function gradientStyle(ctx, fill) {
  const spec = parseGradient(fill);
  const s = spec.shape;
  const gradient =
    s.type === "linear"
      ? ctx.createLinearGradient(s.x1, s.y1, s.x2, s.y2)
      : ctx.createRadialGradient(s.cx, s.cy, 0, s.cx, s.cy, s.r);
  for (const [offset, c] of expandStops(spec.stops, spec.space)) {
    const byte = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    gradient.addColorStop(
      offset,
      `rgba(${byte(c[0])},${byte(c[1])},${byte(c[2])},${c[3]})`,
    );
  }
  return gradient;
}
