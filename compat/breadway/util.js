// Shared helpers: seeded rng, easing, math, text drawing. Pure functions of time.
(function (root) {
  const U = {};
  // frame size: 1920x1080 unless the page URL says otherwise (?w=1080&h=1920 for a vertical film)
  const qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  U.W = +((qs && qs.get('w')) || 1920); U.H = +((qs && qs.get('h')) || 1080);
  U.PAL = {
    bg: '#070707', ink: '#f3e9d2', dim: '#8d8676', gold: '#e6b25e', crust: '#c98a3c',
    blue: '#7fb4ff', teal: '#5fd0c0', red: '#e5484d', violet: '#9b7cff', green: '#7bd88f',
  };
  U.clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.map = (x, a, b, c, d) => c + (d - c) * ((x - a) / (b - a));
  U.sat = (x) => Math.min(1, Math.max(0, x));
  U.seg = (t, a, b) => U.sat((t - a) / (b - a)); // 0..1 progress of t across [a,b]
  U.ease = {
    lin: (t) => t,
    inQ: (t) => t * t,
    outQ: (t) => 1 - (1 - t) * (1 - t),
    outC: (t) => 1 - Math.pow(1 - t, 3),
    outE: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    inOutC: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    inOutS: (t) => t * t * (3 - 2 * t),
    outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    outElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
  };
  U.rng = function (seed) {
    let a = seed >>> 0;
    const f = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return f;
  };
  U.hash = (n) => { n = (n << 13) ^ n; return 1 - ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824; };
  // smooth 1D value noise, deterministic
  U.noise = (x) => {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return U.lerp(U.hash(i), U.hash(i + 1), u);
  };
  U.rgba = (hex, a = 1) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };
  U.mix = (h1, h2, t) => {
    const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
    const r = Math.round(U.lerp(a >> 16, b >> 16, t)), g = Math.round(U.lerp((a >> 8) & 255, (b >> 8) & 255, t)), bl = Math.round(U.lerp(a & 255, b & 255, t));
    return `rgb(${r},${g},${bl})`;
  };
  U.fmt = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // text: o = {font,size,weight,style,color,align,base,alpha,spacing,scale,rot}
  U.T = function (c, str, x, y, o = {}) {
    const fam = o.font || 'Newsreader';
    c.save();
    c.translate(x, y);
    if (o.rot) c.rotate(o.rot);
    if (o.scale && o.scale !== 1) c.scale(o.scale, o.scale);
    c.font = `${o.style || 'normal'} ${o.weight || 400} ${o.size || 48}px "${fam}"`;
    c.letterSpacing = (o.spacing || 0) + 'px';
    c.textAlign = o.align || 'center';
    c.textBaseline = o.base || 'middle';
    c.globalAlpha *= o.alpha === undefined ? 1 : o.alpha;
    c.fillStyle = o.color || U.PAL.ink;
    c.fillText(str, 0, 0);
    c.restore();
  };
  U.measure = function (c, str, o = {}) {
    c.save();
    c.font = `${o.style || 'normal'} ${o.weight || 400} ${o.size || 48}px "${o.font || 'Newsreader'}"`;
    c.letterSpacing = (o.spacing || 0) + 'px';
    const w = c.measureText(str).width;
    c.restore();
    return w;
  };
  U.roundRect = function (c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  };
  // Catmull-Rom through points -> path on ctx
  U.smoothPath = function (c, pts) {
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6, cp1y = p1[1] + (p2[1] - p0[1]) / 6;
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6, cp2y = p2[1] - (p3[1] - p1[1]) / 6;
      c.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
    }
  };
  if (typeof module !== 'undefined') module.exports = U; else root.U = U;
})(typeof window !== 'undefined' ? window : globalThis);
