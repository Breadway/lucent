// A minimal DOM for SVG-authored films running inside the native QuickJS runtime.
//
// Astra scenes build an SVG tree with document.createElementNS and then drive it by setting
// attributes and a few style properties every frame. This models exactly that surface (no
// layout, no CSS), keeps path geometry and text measurement answerable, and serialises the
// tree back to SVG markup for the native renderer.

const SVG_NS = "http://www.w3.org/2000/svg";

// The page's `svg text { font-feature-settings: "cv11","ss01" }` has no effect in the browser
// because its bundled Inter/JetBrains Mono subsets carry no such features, so scene text and
// HTML text use the same plain faces.
export const FAMILY = { sans: "Inter", mono: "JetBrains Mono" };
export const HTML_FAMILY = FAMILY;

// The page declares Inter at 400..800 and JetBrains Mono at 400..600 (assets/fonts.css), each
// pointing at one variable file. A request resolves to a declared weight by the CSS matching
// rules and the variable axis is then set to exactly that weight.
const DECLARED = { sans: [400, 500, 600, 700, 800], mono: [400, 500, 600] };

/** CSS font weight matching onto the declared weights. */
export function cssWeight(w, mono = false) {
  const have = DECLARED[mono ? "mono" : "sans"];
  w = Number(w);
  if (!Number.isFinite(w)) w = 400;
  if (have.includes(w)) return w;
  const above = have.filter((x) => x > w),
    below = have.filter((x) => x < w);
  const up = above.length ? above[0] : null,
    down = below.length ? below[below.length - 1] : null;
  if (w < 400) return down ?? up; // lighter first
  if (w <= 500) return up !== null && up <= 500 ? up : (down ?? up); // up to 500, then lighter
  return up ?? down; // heavier first
}

class TextNode {
  constructor(data) {
    this.data = String(data);
    this.parentNode = null;
  }
  get textContent() {
    return this.data;
  }
}

export class Element {
  constructor(tag) {
    this.tagName = tag;
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this.style = {};
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  setAttributeNS(_ns, k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  hasAttribute(k) {
    return k in this.attrs;
  }
  get id() {
    return this.attrs.id ?? "";
  }
  get className() {
    return this.attrs.class ?? "";
  }
  set className(v) {
    this.attrs.class = String(v);
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = ref ? this.children.indexOf(ref) : -1;
    child.parentNode = this;
    if (i < 0) this.children.push(child);
    else this.children.splice(i, 0, child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parentNode = null;
    }
    return child;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get lastChild() {
    return this.children[this.children.length - 1] ?? null;
  }
  get childNodes() {
    return this.children;
  }
  get textContent() {
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.children = [];
    if (v !== "" && v != null) this.appendChild(new TextNode(v));
  }
  set innerHTML(v) {
    if (v === "") this.children = [];
    else
      throw new Error(
        "innerHTML with markup is not supported by the native DOM",
      );
  }

  // ---- geometry ----------------------------------------------------------------------
  getTotalLength() {
    return pathGeometry(this).total;
  }
  getPointAtLength(len) {
    return pointAt(pathGeometry(this), len);
  }
  getComputedTextLength() {
    const a = this.attrs;
    const mono = (a.class || "").split(/\s+/).includes("mono");
    const text = this.textContent;
    return globalThis.__measure_text(
      text,
      FAMILY[mono ? "mono" : "sans"],
      cssWeight(a["font-weight"] ?? 400, mono),
      Number(a["font-size"] ?? 16),
      Number(a["letter-spacing"] ?? 0),
    );
  }
}

// ---- path geometry ---------------------------------------------------------------------
// Paths are flattened to polylines once per `d` string; length queries then interpolate.

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

function* segments(d) {
  let i = 0;
  const n = d.length;
  const skip = () => {
    while (i < n && /[\s,]/.test(d[i])) i++;
  };
  const num = () => {
    skip();
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) throw new Error(`Bad path data near ${i}: ${d.slice(i, i + 12)}`);
    i = NUM.lastIndex;
    return parseFloat(m[0]);
  };
  const flag = () => {
    skip();
    const c = d[i++];
    return c === "1" ? 1 : 0;
  };
  let cmd = "";
  const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  while (true) {
    skip();
    if (i >= n) return;
    if (/[A-Za-z]/.test(d[i])) cmd = d[i++];
    else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
    const up = cmd.toUpperCase();
    const args = [];
    for (let k = 0; k < ARGS[up]; k++)
      args.push(up === "A" && (k === 3 || k === 4) ? flag() : num());
    yield [cmd, args];
    if (up === "Z") cmd = "";
  }
}

function arcToCubics(x1, y1, rx, ry, phi, large, sweep, x2, y2) {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const rad = (phi * Math.PI) / 180,
    cos = Math.cos(rad),
    sin = Math.sin(rad);
  const dx = (x1 - x2) / 2,
    dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy,
    y1p = -sin * dx + cos * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry,
    cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2,
    cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;
  const parts = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
  const step = dth / parts,
    k = (4 / 3) * Math.tan(step / 4);
  const out = [];
  let t = th1;
  for (let p = 0; p < parts; p++) {
    const c1 = Math.cos(t),
      s1 = Math.sin(t),
      c2 = Math.cos(t + step),
      s2 = Math.sin(t + step);
    const pt = (x, y) => [
      cos * rx * x - sin * ry * y + cx,
      sin * rx * x + cos * ry * y + cy,
    ];
    const [ax, ay] = pt(c1 - k * s1, s1 + k * c1);
    const [bx, by] = pt(c2 + k * s2, s2 - k * c2);
    const [ex, ey] = pt(c2, s2);
    out.push([ax, ay, bx, by, ex, ey]);
    t += step;
  }
  return out;
}

function flatten(d) {
  const pts = [];
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    lcx = 0,
    lcy = 0,
    lqx = 0,
    lqy = 0,
    prev = "";
  const line = (nx, ny) => {
    pts.push([x, y, nx, ny]);
    x = nx;
    y = ny;
  };
  const cubic = (c1x, c1y, c2x, c2y, ex, ey) => {
    const x0 = x,
      y0 = y,
      N = 24;
    for (let s = 1; s <= N; s++) {
      const t = s / N,
        u = 1 - t;
      line(
        u * u * u * x0 +
          3 * u * u * t * c1x +
          3 * u * t * t * c2x +
          t * t * t * ex,
        u * u * u * y0 +
          3 * u * u * t * c1y +
          3 * u * t * t * c2y +
          t * t * t * ey,
      );
    }
    lcx = c2x;
    lcy = c2y;
  };
  for (const [cmd, a] of segments(d)) {
    const rel = cmd !== cmd.toUpperCase();
    const up = cmd.toUpperCase();
    const ox = rel ? x : 0,
      oy = rel ? y : 0;
    switch (up) {
      case "M":
        x = sx = a[0] + ox;
        y = sy = a[1] + oy;
        break;
      case "L":
        line(a[0] + ox, a[1] + oy);
        break;
      case "H":
        line(a[0] + ox, y);
        break;
      case "V":
        line(x, a[0] + oy);
        break;
      case "C":
        cubic(a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy, a[4] + ox, a[5] + oy);
        break;
      case "S": {
        const smooth = prev === "C" || prev === "S";
        cubic(
          smooth ? 2 * x - lcx : x,
          smooth ? 2 * y - lcy : y,
          a[0] + ox,
          a[1] + oy,
          a[2] + ox,
          a[3] + oy,
        );
        break;
      }
      case "Q":
      case "T": {
        let qx, qy, ex, ey;
        if (up === "Q") {
          qx = a[0] + ox;
          qy = a[1] + oy;
          ex = a[2] + ox;
          ey = a[3] + oy;
        } else {
          const smooth = prev === "Q" || prev === "T";
          qx = smooth ? 2 * x - lqx : x;
          qy = smooth ? 2 * y - lqy : y;
          ex = a[0] + ox;
          ey = a[1] + oy;
        }
        cubic(
          x + (2 / 3) * (qx - x),
          y + (2 / 3) * (qy - y),
          ex + (2 / 3) * (qx - ex),
          ey + (2 / 3) * (qy - ey),
          ex,
          ey,
        );
        lqx = qx;
        lqy = qy;
        break;
      }
      case "A":
        for (const c of arcToCubics(
          x,
          y,
          a[0],
          a[1],
          a[2],
          a[3],
          a[4],
          a[5] + ox,
          a[6] + oy,
        ))
          cubic(...c);
        break;
      case "Z":
        if (x !== sx || y !== sy) line(sx, sy);
        break;
    }
    prev = up;
  }
  return pts;
}

function pathGeometry(el) {
  const d = el.attrs.d ?? "";
  if (el.__geo && el.__geo.d === d) return el.__geo;
  const lines = flatten(d);
  const cum = [];
  let total = 0;
  for (const [x0, y0, x1, y1] of lines) {
    total += Math.hypot(x1 - x0, y1 - y0);
    cum.push(total);
  }
  return (el.__geo = { d, lines, cum, total });
}

function pointAt({ lines, cum, total }, len) {
  if (!lines.length) return { x: 0, y: 0 };
  len = Math.max(0, Math.min(total, len));
  let lo = 0,
    hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < len) lo = mid + 1;
    else hi = mid;
  }
  const [x0, y0, x1, y1] = lines[lo];
  const start = lo ? cum[lo - 1] : 0,
    seg = cum[lo] - start;
  const u = seg > 0 ? (len - start) / seg : 0;
  return { x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u };
}

// ---- document ----------------------------------------------------------------------------
export function installDocument() {
  const document = {
    createElementNS: (_ns, tag) => new Element(tag),
    createElement: (tag) => new Element(tag),
    createTextNode: (s) => new TextNode(s),
    getElementById: () => null,
    fonts: {
      status: "loaded",
      ready: Promise.resolve(),
      load: () => Promise.resolve([]),
    },
    body: new Element("body"),
  };
  // Only the native runtime lacks a DOM. In a browser the real one stays in place, and the
  // film is not meant to be run there (it is classified portable for the native backend).
  if (typeof globalThis.document === "undefined") {
    globalThis.document = document;
    installLocale();
  }
  return globalThis.document;
}

// QuickJS has no Intl: provide the en-US grouping the scenes rely on.
function installLocale() {
  const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  Number.prototype.toLocaleString = function (_locale, opts = {}) {
    const min = opts.minimumFractionDigits ?? 0;
    const max = Math.max(min, opts.maximumFractionDigits ?? 3);
    let s = this.toFixed(max);
    if (s.includes(".")) {
      s = s.replace(/0+$/, "");
      const decimals = s.length - s.indexOf(".") - 1;
      if (decimals < min) s += "0".repeat(min - decimals);
      s = s.replace(/\.$/, "");
    }
    const [int, frac] = s.split(".");
    return group(int) + (frac ? "." + frac : "");
  };
}

// ---- text with glyphs the page font lacks -------------------------------------------------------
// The page's Inter and JetBrains Mono are latin subsets, so characters such as arrows and the
// square root come from a fallback font. The renderer reshapes a whole run in the fallback as
// soon as one glyph is missing, which changes every other glyph in it. So text containing such
// characters is split into runs here and each run is placed at a measured position, which is what
// the browser's per-glyph fallback amounts to.

// Fallbacks in the order that reproduces the browser's choices (see tools/prepare-fonts.sh): it
// drew arrows, the square root and similar from an Arial-compatible face.
const FALLBACKS = ["Liberation Sans", "DejaVu Sans", "Noto Sans"];
// hhea ascent/descent per em of the page fonts: `dominant-baseline: central` is measured from the
// primary font even when a run is drawn in a fallback.
const METRICS = {
  Inter: [1984 / 2048, 494 / 2048],
  "JetBrains Mono": [1.02, 0.3],
};
const glyphCache = new Map();
const hasGlyph = (family, code) => {
  const key = `${family}|${code}`;
  let v = glyphCache.get(key);
  if (v === undefined)
    glyphCache.set(key, (v = globalThis.__has_glyph(family, code)));
  return v;
};
const fallbackFor = (code) =>
  FALLBACKS.find((f) => hasGlyph(f, code)) ?? FALLBACKS[0];

/** Runs [{text, family}] for `text`, or null when the primary font covers all of it. */
function glyphRuns(text, primary) {
  if (!/[^\x00-\xff]/.test(text)) return null;
  const runs = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const family =
      code <= 0xff || hasGlyph(primary, code) ? primary : fallbackFor(code);
    const last = runs[runs.length - 1];
    if (last && last.family === family) last.text += ch;
    else runs.push({ text: ch, family });
  }
  return runs.length === 1 && runs[0].family === primary ? null : runs;
}

/** SVG for a <text> element whose content needs fallback runs; null when it does not. */
function splitText(el, attrs, out) {
  const primary = attrs["font-family"];
  const text = el.textContent.replace(/\s+/g, " ").trim();
  const runs = glyphRuns(text, primary);
  if (!runs) return false;
  const mono = primary === FAMILY.mono;
  const size = Number(attrs["font-size"] ?? 16),
    ls = Number(attrs["letter-spacing"] ?? 0);
  const weight = cssWeight(attrs["font-weight"] ?? 400, mono);
  const widths = runs.map((r) =>
    globalThis.__measure_text(
      r.text,
      r.family,
      r.family === primary ? weight : 400,
      size,
      ls,
    ),
  );
  const total = widths.reduce((a, b) => a + b, 0);
  const anchor = attrs["text-anchor"] ?? "start";
  let x =
    Number(attrs.x ?? 0) -
    (anchor === "middle" ? total / 2 : anchor === "end" ? total : 0);
  let y = Number(attrs.y ?? 0);
  if (attrs["dominant-baseline"] === "central") {
    const [asc, desc] = METRICS[primary] ?? [0.97, 0.24];
    y += ((asc - desc) / 2) * size;
  }
  // Presentation attributes (fill, size, weight, spacing, transform, opacity, filter ...) stay on
  // a group; each run only carries its position and family.
  const {
    x: _x,
    y: _y,
    "text-anchor": _a,
    "dominant-baseline": _d,
    "font-family": _f,
    "xml:space": _s,
    ...rest
  } = attrs;
  out.push("<g");
  for (const k in rest) out.push(" ", k, '="', escAttr(rest[k]), '"');
  out.push(' text-anchor="start" xml:space="preserve">');
  runs.forEach((r, i) => {
    out.push(
      `<text x="${+x.toFixed(3)}" y="${+y.toFixed(3)}" font-family="${r.family}">`,
      esc(r.text),
      "</text>",
    );
    x += widths[i];
  });
  out.push("</g>");
  return true;
}

// ---- serialisation -------------------------------------------------------------------------
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
const kebab = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

/** SVG text for an element and its subtree. Elements hidden by style are omitted. */
export function serialize(el, out = []) {
  if (el instanceof TextNode) {
    out.push(esc(el.data));
    return out;
  }
  const st = el.style;
  if (st.display === "none" || st.visibility === "hidden") return out;
  let tag = el.tagName;
  const attrs = { ...el.attrs };
  // A full-bleed layer <svg viewBox="0 0 W H" width=W height=H> is an identity mapping and
  // must not clip: draw it as a plain group.
  if (tag === "svg" && attrs.viewBox === "0 0 1920 1080") {
    tag = "g";
    delete attrs.viewBox;
    delete attrs.width;
    delete attrs.height;
  }
  if (tag === "text") {
    const classes = (attrs.class || "").split(/\s+/);
    attrs["font-family"] ??= FAMILY[classes.includes("mono") ? "mono" : "sans"];
    if ("font-weight" in attrs)
      attrs["font-weight"] = cssWeight(
        attrs["font-weight"],
        classes.includes("mono"),
      );
  }
  delete attrs.class;
  for (const [k, v] of Object.entries(st)) {
    if (v === "" || v == null) continue;
    if (k === "display" || k === "visibility") continue;
    if (k === "whiteSpace") {
      if (v === "pre") attrs["xml:space"] = "preserve";
      continue;
    }
    if (k === "transform")
      throw new Error("CSS transform on an SVG element is not supported");
    attrs[kebab(k)] = v;
  }
  if (tag === "text" && splitText(el, attrs, out)) return out;
  out.push("<", tag);
  for (const k in attrs) out.push(" ", k, '="', escAttr(attrs[k]), '"');
  if (!el.children.length) {
    out.push("/>");
    return out;
  }
  out.push(">");
  for (const c of el.children) serialize(c, out);
  out.push("</", tag, ">");
  return out;
}

export { SVG_NS };
