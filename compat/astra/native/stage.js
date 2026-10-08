// Native port of the Astra Stage (compat/astra/stage.js).
//
// The timeline, narration retiming, transition maths and per-scene update calls are the
// browser Stage's, line for line. What differs is the output: instead of mutating DOM and
// canvas, seek() returns one SVG document for the whole frame (background, scenes, HUD,
// captions, vignette, progress bar) that the native renderer rasterises. The CSS and canvas
// 2D parts of the original page are expressed here as SVG with the same numbers.
import { clamp, lerp, E, C, hn } from "../core.js";
import {
  serialize,
  installDocument,
  HTML_FAMILY as FAMILY,
  cssWeight,
} from "./dom.js";

export const W = 1920,
  HT = 1080,
  FPS = 30;

const DEFS = `<defs>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="glow2" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="12" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity=".5"/></filter>
<linearGradient id="surface" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14203a"/><stop offset="1" stop-color="#0c1526"/></linearGradient>
<linearGradient id="surface-on" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2c4a"/><stop offset="1" stop-color="#101b30"/></linearGradient>
<linearGradient id="gcp" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7be3d5"/><stop offset="1" stop-color="#b6a1ff"/></linearGradient>
<linearGradient id="gpg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#b6a1ff"/><stop offset="1" stop-color="#f2c67b"/></linearGradient>
<linearGradient id="gred" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff7a8a"/><stop offset="1" stop-color="#f2c67b"/></linearGradient>
<marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#6f8aa8"/></marker>
<linearGradient id="sweepg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".1" stop-color="rgb(123,227,213)" stop-opacity="0"/><stop offset=".5" stop-color="rgb(160,240,255)" stop-opacity=".3"/><stop offset=".9" stop-color="rgb(182,161,255)" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
<radialGradient id="vignette" gradientUnits="userSpaceOnUse" cx="960" cy="540" r="1" gradientTransform="translate(960 540) scale(1440 756) translate(-960 -540)"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>
<linearGradient id="progg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7be3d5"/><stop offset=".5" stop-color="#b6a1ff"/><stop offset="1" stop-color="#f2c67b"/></linearGradient>
<linearGradient id="railon" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7be3d5"/><stop offset="1" stop-color="#b6a1ff"/></linearGradient>
<filter id="hudglow" x="-100%" y="-300%" width="300%" height="700%"><feGaussianBlur stdDeviation="7"/></filter>
<filter id="capshadow" x="-20%" y="-60%" width="140%" height="260%"><feGaussianBlur stdDeviation="25"/></filter>
</defs>`;

const f = (n, d = 2) => +n.toFixed(d);
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const measureCache = new Map();
function measure(text, { mono = false, weight = 400, size = 16, ls = 0 }) {
  const key = `${mono}|${weight}|${size}|${ls}|${text}`;
  let w = measureCache.get(key);
  if (w === undefined) {
    w = globalThis.__measure_text(
      text,
      FAMILY[mono ? "mono" : "sans"],
      weight,
      size,
      ls,
    );
    measureCache.set(key, w);
  }
  return w;
}

export class Stage {
  constructor(scenes, narr = null, opts = {}) {
    const document = globalThis.document ?? installDocument();
    this.opts = opts;
    this.film = opts.film || "astra";
    this.defs = [];

    // ----- timeline -----
    let cursor = 0;
    // optional narration retiming: scene length follows the spoken audio, and the scene's animation clock is
    // piecewise-linearly warped so each caption's visual cue lands on the word that introduces it.
    if (narr)
      scenes = scenes.map((sc) => {
        const n = narr[sc.id];
        if (!n || !sc.caps || !sc.caps.length) return sc;
        const lead = n.lead ?? 0.5;
        const newCaps = sc.caps.map((c, i) => [lead + n.caps[i], c[1]]);
        const dur = Math.max(
          lead + n.dur + 1.6,
          newCaps[newCaps.length - 1][0] + 2.5,
          opts.pacing === "original" ? sc.dur : 0,
        );
        const pts = [
          [0, 0],
          ...sc.caps.map((c, i) => [newCaps[i][0], c[0]]),
          [dur, Math.max(sc.dur, sc.caps[sc.caps.length - 1][0] + 1)],
        ];
        const warp = (t) => {
          if (t <= 0) return 0;
          for (let k = 1; k < pts.length; k++)
            if (t <= pts[k][0]) {
              const [a0, b0] = pts[k - 1],
                [a1, b1] = pts[k];
              return b0 + ((t - a0) / (a1 - a0 || 1)) * (b1 - b0);
            }
          return pts[pts.length - 1][1] + (t - pts[pts.length - 1][0]);
        };
        return {
          ...sc,
          caps: newCaps,
          dur,
          warp,
          narr: { id: sc.id, lead, dur: n.dur },
        };
      });
    this.scenes = scenes.map((sc, i) => {
      const trans = i === 0 ? 0 : (sc.trans ?? 0.8);
      const start = i === 0 ? 0 : cursor - trans;
      cursor = start + sc.dur;
      const root = document.createElement("div");
      const o = { ...sc, trans, start, end: cursor, root, ctx: {} };
      return o;
    });
    this.total = cursor;
    this.scenes.forEach((s, i) => {
      s.nextTrans = this.scenes[i + 1] ? this.scenes[i + 1].trans : 0;
    });
    // dominant-scene boundaries (midpoint of each overlap)
    this.scenes.forEach((s, i) => {
      s.domStart = i === 0 ? -1 : s.start + s.trans / 2;
      s.domEnd =
        i === this.scenes.length - 1 ? s.end + 1 : s.end - s.nextTrans / 2;
    });

    // build scene DOM
    for (const s of this.scenes) s.state = s.build(s.root, s) || {};
  }

  timeline() {
    return {
      total: this.total,
      fps: FPS,
      scenes: this.scenes.map((s) => ({
        id: s.id,
        title: s.title,
        start: s.start,
        dur: s.dur,
        ver: s.ver ?? null,
        ch: s.ch ?? null,
        caps: s.caps || [],
        narr: s.narr || null,
      })),
    };
  }

  /** The whole frame at time T as one SVG document. */
  seek(T, frame = Math.round(T * FPS)) {
    T = clamp(T, 0, this.total - 1e-4);
    const out = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${HT}" viewBox="0 0 ${W} ${HT}">`,
      DEFS,
    ];
    const weights = [];
    const shown = [];
    for (const s of this.scenes) {
      const t = T - s.start;
      const vis = t > -0.001 && t < s.dur + 0.001;
      if (!vis) continue;
      const wIn = s.trans > 0 ? E.inOutC(clamp(t / s.trans)) : 1;
      const wOut =
        s.nextTrans > 0
          ? 1 - E.inOutC(clamp((t - (s.dur - s.nextTrans)) / s.nextTrans))
          : 1;
      let o = wIn * wOut;
      if (s === this.scenes[0]) o *= clamp(T / 0.6);
      if (s === this.scenes[this.scenes.length - 1])
        o *= clamp((this.total - T) / 1.2);
      const drift = 1 + (s.drift ?? 0.022) * (t / s.dur);
      const wt = s.warp ? s.warp(Math.max(0, t)) : Math.max(0, t);
      const cam = s.cam ? s.cam(wt, s.state) : null;
      const sc =
        lerp(0.955, 1, wIn) *
        lerp(1.07, 1, wOut) *
        (cam ? (cam.s ?? 1) : drift);
      const blur = (1 - wIn) * 10 + (1 - wOut) * 8;
      s.update(s.warp ? s.warp(Math.max(0, t)) : Math.max(0, t), s.state, s);
      weights.push([s, o]);
      shown.push({
        s,
        o,
        sc,
        blur,
        tx: cam ? (cam.x ?? 0) : 0,
        ty: cam ? (cam.y ?? 0) : 0,
      });
    }
    // transition sweep streak
    let sw = 0;
    for (const s of this.scenes) {
      if (s.trans > 0) {
        const u = (T - s.start) / s.trans;
        if (u > 0 && u < 1) sw = u;
      }
    }

    out.push(this.background(T, weights));
    shown.forEach(({ s, o, sc, blur, tx, ty }, i) => {
      // CSS blur() on a whole scene. A filter's default region is the content's bounding box
      // padded by 10%, which resvg then clamps to five times the canvas; pin it to the frame
      // so a transition costs a frame-sized blur and not a many-frame-sized one.
      let filter = "";
      if (blur > 0.2) {
        out.push(
          `<defs><filter id="sceneblur${i}" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${HT}"><feGaussianBlur stdDeviation="${blur.toFixed(1)}"/></filter></defs>`,
        );
        filter = ` filter="url(#sceneblur${i})"`;
      }
      out.push(
        `<g opacity="${f(o, 4)}" transform="translate(960 540) translate(${f(tx)} ${f(ty)}) scale(${f(sc, 5)}) translate(-960 -540)"${filter}>`,
      );
      for (const c of s.root.children) serialize(c, out);
      out.push("</g>");
    });
    if (sw > 0) {
      const x = lerp(-700, W + 300, E.inOutC(sw));
      out.push(
        `<g style="mix-blend-mode:screen" opacity="${f(Math.sin(sw * Math.PI) * 0.9, 4)}" transform="translate(260 550) translate(${f(x)} 0) skewX(-18) translate(-260 -550)"><rect x="0" y="-100" width="520" height="1300" fill="url(#sweepg)"/></g>`,
      );
    }
    out.push(this.hud(T));
    out.push(this.captions(T));
    out.push(`<rect width="${W}" height="${HT}" fill="url(#vignette)"/>`);
    out.push(
      `<rect x="0" y="${HT - 5}" width="${f((T / this.total) * W, 3)}" height="5" fill="url(#progg)" opacity=".9"/>`,
    );
    out.push("</svg>");
    return out.join("");
  }

  moodOf(s) {
    return s.mood || [C.cyan, C.purple, C.blue];
  }

  background(T, weights) {
    // blended mood
    let tot = 0;
    const cols = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (const [s, o] of weights) {
      const m = this.moodOf(s);
      for (let i = 0; i < 3; i++) {
        const v = rgbOf(m[i] || m[0]);
        for (let j = 0; j < 3; j++) cols[i][j] += v[j] * o;
      }
      tot += o;
    }
    tot = tot || 1;
    const col = cols.map((c) => c.map((v) => Math.round(v / tot)));
    const o = [`<rect width="${W}" height="${HT}" fill="${C.bg}"/>`, "<defs>"];
    // aurora blobs
    const blobs = [
      [
        0.22 + 0.1 * Math.sin(T * 0.11),
        0.3 + 0.08 * Math.cos(T * 0.09),
        760,
        0,
        0.2,
      ],
      [
        0.78 + 0.08 * Math.cos(T * 0.07),
        0.68 + 0.1 * Math.sin(T * 0.13),
        820,
        1,
        0.17,
      ],
      [
        0.55 + 0.12 * Math.sin(T * 0.05 + 2),
        0.12 + 0.05 * Math.cos(T * 0.17),
        600,
        2,
        0.12,
      ],
    ];
    blobs.forEach(([bx, by, r, ci, a], i) => {
      const [cr, cg, cb] = col[ci];
      o.push(
        `<radialGradient id="aurora${i}" gradientUnits="userSpaceOnUse" cx="${f(bx * W)}" cy="${f(by * HT)}" r="${r}"><stop offset="0" stop-color="rgb(${cr},${cg},${cb})" stop-opacity="${a}"/><stop offset="1" stop-color="rgb(${cr},${cg},${cb})" stop-opacity="0"/></radialGradient>`,
      );
    });
    o.push("</defs>");
    blobs.forEach((_, i) =>
      o.push(`<rect width="${W}" height="${HT}" fill="url(#aurora${i})"/>`),
    );
    // dot grid
    const gs = 44,
      off = (T * 3) % gs;
    const dots = [];
    for (let gx = -off; gx < W; gx += gs)
      for (let gy = 0; gy < HT; gy += gs)
        dots.push(`M${f(gx, 3)} ${gy}h1.5v1.5h-1.5z`);
    o.push(
      `<path d="${dots.join("")}" fill="rgb(120,150,190)" fill-opacity=".09"/>`,
    );
    // stars in 3 parallax layers
    for (let L = 0; L < 3; L++) {
      const n = 70 + L * 20,
        sp = 6 + L * 14,
        sz = 0.8 + L * 0.7;
      for (let i = 0; i < n; i++) {
        const bx = hn(i, L, 1) * W,
          by = hn(i, L, 2) * HT;
        const px = (((bx - T * sp) % W) + W) % W;
        const py = by + Math.sin(T * 0.3 + i) * 6 * (L + 1) * 0.4;
        const tw =
          0.35 +
          0.65 * (0.5 + 0.5 * Math.sin(T * (0.8 + hn(i, L, 3) * 2) + i * 7));
        o.push(
          `<rect x="${f(px, 3)}" y="${f(py, 3)}" width="${f(sz, 2)}" height="${f(sz, 2)}" fill="rgb(210,230,255)" fill-opacity="${f((0.1 + L * 0.12) * tw, 4)}"/>`,
        );
      }
    }
    // shooting star every ~9s
    const per = 9,
      k = Math.floor(T / per),
      u = (T - k * per) / 1.1;
    if (u >= 0 && u < 1) {
      const sx = hn(k, 9) * W * 0.7,
        sy = hn(k, 10) * HT * 0.4;
      const hx = sx + u * 520,
        hy = sy + u * 240;
      o.push(
        `<defs><linearGradient id="shoot" gradientUnits="userSpaceOnUse" x1="${f(hx - 160)}" y1="${f(hy - 74)}" x2="${f(hx)}" y2="${f(hy)}"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="rgb(190,240,255)" stop-opacity="${f(0.8 * Math.sin(u * Math.PI), 4)}"/></linearGradient></defs>`,
      );
      o.push(
        `<path d="M${f(hx - 160)} ${f(hy - 74)}L${f(hx)} ${f(hy)}" stroke="url(#shoot)" stroke-width="2" fill="none"/>`,
      );
    }
    return o.join("");
  }

  currentScene(T) {
    let cur = null;
    for (const s of this.scenes) if (T >= s.domStart && T < s.domEnd) cur = s;
    return cur;
  }

  hud(T) {
    if (this.film !== "edu") return "";
    const cur = this.currentScene(T);
    const ch = cur?.ch ?? 0;
    if (!ch) return "";
    const right = W - 56;
    const o = ["<g>"];
    // chapter rail: 26x7 segments, 4px apart, right aligned at the top
    const n = this.opts.chapters.length;
    const x0 = right - (n * 26 + (n - 1) * 4);
    for (let i = 0; i < n; i++) {
      const x = x0 + i * 30,
        on = i + 1 === ch,
        done = i + 1 < ch;
      if (on) {
        o.push(
          `<rect x="${x}" y="${46 - 1.75}" width="26" height="10.5" rx="4" fill="rgb(123,227,213)" fill-opacity=".55" filter="url(#hudglow)"/>`,
        );
        o.push(
          `<rect x="${x}" y="${46 - 1.75}" width="26" height="10.5" rx="4" fill="url(#railon)"/>`,
        );
      } else
        o.push(
          `<rect x="${x}" y="46" width="26" height="7" rx="3.5" fill="${done ? "#3d6f72" : "#1c2a40"}"/>`,
        );
    }
    // chapter name
    const label =
      `${String(ch).padStart(2, "0")} · ${this.opts.chapters[ch - 1]}`.toUpperCase();
    const nameStyle = { mono: true, weight: 600, size: 14, ls: 1.4 };
    const nameW = measure(label, nameStyle);
    o.push(
      `<text x="${f(right - nameW)}" y="${f(63 + 1.02 * 14 + (18.48 - 1.32 * 14) / 2)}" font-family="${FAMILY.mono}" font-size="14" font-weight="600" letter-spacing="1.4" fill="#7be3d5">${label.replace(/&/g, "&amp;")}</text>`,
    );
    // location chips
    const chip = { mono: true, weight: 600, size: 11, ls: 1.32 };
    const widths = this.opts.loc.map((name) => measure(name, chip) + 18 + 2);
    let x = right - widths.reduce((a, b) => a + b, 0) - 6 * (widths.length - 1);
    const top = 63 + 18.48 + 10,
      hgt = 11 * 1.32 + 8 + 2;
    this.opts.loc.forEach((name, i) => {
      const on = name.toLowerCase() === (cur?.loc || "");
      const w = widths[i];
      o.push(
        `<rect x="${f(x + 0.5)}" y="${f(top + 0.5)}" width="${f(w - 1)}" height="${f(hgt - 1)}" rx="6.5" fill="${on ? "#7be3d5" : "rgb(10,18,32)"}" fill-opacity="${on ? 1 : 0.6}" stroke="${on ? "none" : "#243349"}"/>`,
      );
      o.push(
        `<text x="${f(x + 10)}" y="${f(top + 5 + 1.02 * 11 + (11 * 1.32 - 1.32 * 11) / 2)}" font-family="${FAMILY.mono}" font-size="11" font-weight="600" letter-spacing="1.32" fill="${on ? "#07101c" : "#51647e"}">${name}</text>`,
      );
      x += w + 6;
    });
    o.push("</g>");
    return o.join("");
  }

  captions(T) {
    const cur = this.currentScene(T);
    if (!cur || !cur.caps || !cur.caps.length) return "";
    const t = T - cur.start;
    let idx = -1;
    for (let i = 0; i < cur.caps.length; i++) if (t >= cur.caps[i][0]) idx = i;
    if (idx < 0) return "";
    const at = cur.caps[idx][0];
    const nextAt =
      idx + 1 < cur.caps.length ? cur.caps[idx + 1][0] : cur.dur - 0.2;
    const lt = t - at;

    // words, with the *highlight* markers the caption text uses
    let hl = false;
    const words = cur.caps[idx][1].split(" ").map((w) => {
      let h = hl;
      if (w.startsWith("*")) {
        hl = true;
        h = true;
        w = w.slice(1);
      }
      if (w.includes("*")) {
        w = w.replace("*", "");
        hl = false;
        h = true;
      }
      return { w, h };
    });
    const style = { weight: cssWeight(560), size: 34, ls: -0.408 };
    // Chrome lays inline boxes out in 1/64px units. Matching two captions whose lines land within
    // a third of a pixel of the box width (one fits, one does not) is consistent with the
    // between-word spaces being rounded up and the words themselves to nearest.
    const space = Math.ceil(measure(" ", style) * 64 - 1e-6) / 64;
    words.forEach((word) => {
      word.width = Math.round(measure(word.w, style) * 64) / 64;
    });

    // greedy line breaking inside the 1380px max-width box (1px border + 34px padding)
    const maxContent = 1380 - 70;
    const lines = [[]];
    let width = 0;
    for (const word of words) {
      const next = lines[lines.length - 1].length
        ? width + space + word.width
        : word.width;
      if (lines[lines.length - 1].length && next > maxContent) {
        lines.push([word]);
        width = word.width;
      } else {
        lines[lines.length - 1].push(word);
        width = next;
      }
    }
    const lineWidth = (line) =>
      line.reduce((a, w) => a + w.width, 0) + space * (line.length - 1);
    const widest = Math.max(...lines.map(lineWidth));
    const boxW = lines.length > 1 ? 1380 : Math.min(1380, widest + 70);
    const lh = 34 * 1.32;
    const boxH = lines.length * lh + 16 + 18 + 2;
    const bx = (W - boxW) / 2,
      by = HT - 46 - boxH;

    const pLine = E.outC(clamp(lt / 0.35));
    const opacity = idx + 1 < cur.caps.length ? 1 : clamp((nextAt - t) / 0.3);
    const o = [
      `<g opacity="${f(opacity, 4)}" transform="translate(0 ${f((1 - pLine) * 10)})">`,
    ];
    const rr = (x, y, w, h, r) =>
      `M${f(x + r)} ${f(y)}H${f(x + w - r)}A${r} ${r} 0 0 1 ${f(x + w)} ${f(y + r)}V${f(y + h - r)}A${r} ${r} 0 0 1 ${f(x + w - r)} ${f(y + h)}H${f(x + r)}A${r} ${r} 0 0 1 ${f(x)} ${f(y + h - r)}V${f(y + r)}A${r} ${r} 0 0 1 ${f(x + r)} ${f(y)}Z`;
    // box-shadow is only visible outside the border box
    o.push(
      `<clipPath id="capcut"><path clip-rule="evenodd" d="M-200 -200H${W + 200}V${HT + 200}H-200Z ${rr(bx, by, boxW, boxH, 18)}"/></clipPath>`,
    );
    o.push(
      `<g clip-path="url(#capcut)"><path d="${rr(bx, by + 14, boxW, boxH, 18)}" fill="#000" fill-opacity=".5" filter="url(#capshadow)"/></g>`,
    );
    o.push(
      `<path d="${rr(bx + 0.5, by + 0.5, boxW - 1, boxH - 1, 17.5)}" fill="rgb(8,14,26)" fill-opacity=".74" stroke="rgb(70,95,130)" stroke-opacity=".45"/>`,
    );
    // Inter: ascent .96875, descent .2412 (em); the line box centres the content area.
    const baseOffset = (lh - 34 * 1.21) / 2 + 34 * 0.96875;
    let i = 0;
    lines.forEach((line, li) => {
      let x = bx + 35 + (boxW - 70 - lineWidth(line)) / 2;
      const y = by + 17 + li * lh + baseOffset;
      for (const word of line) {
        const p = E.outC(clamp((lt - i * 0.06) / 0.4));
        o.push(
          `<text x="${f(x, 3)}" y="${f(y + (1 - p) * 14, 3)}" font-family="${FAMILY.sans}" font-size="34" font-weight="${style.weight}" letter-spacing="-0.408" fill="${word.h ? "#7be3d5" : "#eef3f9"}" opacity="${f(p, 4)}">${word.w.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`,
        );
        x += word.width + space;
        i++;
      }
    });
    o.push("</g>");
    return o.join("");
  }
}
