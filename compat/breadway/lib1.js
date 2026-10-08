// Base components: background, dust, HUD, narration, typewriter, particle text.
(function () {
  const { W, H, PAL, clamp, sat, lerp, seg, ease, rng, T, rgba, measure } = U;
  const L = (window.L = window.L || {});

  L.bg = function (c, o = {}) {
    const tint = o.tint || [230, 178, 94], a = o.a === undefined ? 0.10 : o.a;
    const cx = o.x === undefined ? W / 2 : o.x, cy = o.y === undefined ? H / 2 : o.y;
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, o.r || 950);
    g.addColorStop(0, `rgba(${tint[0]},${tint[1]},${tint[2]},${a})`);
    g.addColorStop(1, `rgba(${tint[0]},${tint[1]},${tint[2]},0)`);
    c.fillStyle = g; c.fillRect(0, 0, W, H);
  };

  const dustCache = {};
  L.dust = function (c, t, seed = 1, n = 90, o = {}) {
    let d = dustCache[seed + ':' + n];
    if (!d) {
      const r = rng(seed); d = [];
      for (let i = 0; i < n; i++) d.push({ x: r(), y: r(), z: 0.3 + r() * 0.7, ph: r() * 6.28, sp: 0.4 + r() });
      dustCache[seed + ':' + n] = d;
    }
    const col = o.color || PAL.ink, al = o.alpha === undefined ? 0.5 : o.alpha;
    c.save();
    for (const p of d) {
      const x = ((p.x * W + t * (o.vx || 6) * p.z) % W + W) % W;
      const y = (((p.y * H - t * (o.vy || 8) * p.z) % H) + H) % H;
      const tw = 0.5 + 0.5 * Math.sin(t * p.sp * 1.5 + p.ph);
      c.globalAlpha = al * p.z * tw * (o.mul === undefined ? 1 : o.mul);
      c.fillStyle = col;
      const s = 1 + p.z * 1.8;
      c.fillRect(x, y, s, s);
    }
    c.restore();
  };

  // chapter HUD. o = {n, title, rk, rv, color}
  L.hud = function (c, S, o) {
    const lt = S.t - S.data.start;
    const a = sat(lt / 0.6) * (o.alpha === undefined ? 1 : o.alpha);
    c.save(); c.globalAlpha = a;
    const col = o.color || PAL.gold;
    c.fillStyle = col; c.beginPath(); c.arc(92, 92, 6, 0, 7); c.fill();
    T(c, o.n, 112, 92, { font: 'JetBrains Mono', size: 26, weight: 700, spacing: 4, color: col, align: 'left' });
    T(c, o.title, 86, 132, { font: 'JetBrains Mono', size: 26, spacing: 6, color: '#a89f8c', align: 'left' });
    if (o.rk) {
      T(c, o.rk, W - 92, 88, { font: 'JetBrains Mono', size: 20, spacing: 5, color: '#a89f8c', align: 'right' });
      T(c, o.rv, W - 92, 128, { font: 'JetBrains Mono', size: 42, weight: 700, color: '#c9c2b0', align: 'right' });
    }
    c.restore();
  };

  const STY = {
    serif: { font: 'Newsreader', size: 54, weight: 400 },
    italic: { font: 'Newsreader', size: 54, weight: 300, style: 'italic' },
    big: { font: 'Newsreader', size: 112, weight: 500 },
    huge: { font: 'Newsreader', size: 160, weight: 500 },
    small: { font: 'Newsreader', size: 40, weight: 400 },
    mono: { font: 'JetBrains Mono', size: 34, weight: 400 },
    monobig: { font: 'JetBrains Mono', size: 46, weight: 700 },
  };
  L.STY = STY;

  // Stacked reveal of S.data.lines. Line: {t, text, s:style, acc:substr, accColor, wd, mode:'type', size, color, gap}
  L.narrate = function (c, S, o = {}) {
    const lines = S.data.lines || [];
    const lt = S.t - S.data.start;
    const cx = o.cx === undefined ? W / 2 : o.cx, cy = o.cy === undefined ? H / 2 : o.cy;
    const align = o.align || 'center';
    const lhMul = o.lh || 1.42;
    const keep = o.keep === undefined ? 3 : o.keep;
    const shiftT = 0.55;
    const n = lines.length;
    for (let i = 0; i < n; i++) {
      const l = lines[i];
      if (lt < l.t) continue;
      const st = Object.assign({}, STY[l.s || 'serif'], l.size ? { size: l.size } : {});
      // number of newer lines (fractional via easing) to place this line
      let rf = 0, shift = 0;
      for (let j = i + 1; j < n; j++) {
        if (lt >= lines[j].t) {
          const e = ease.outC(sat((lt - lines[j].t) / shiftT));
          rf += e;
          const stj = STY[lines[j].s || 'serif']; const szj = lines[j].size || stj.size;
          shift += e * (szj * lhMul + (lines[j].gap || 0));
        }
      }
      const base = [1, 0.5, 0.28, 0.14, 0.08];
      const ri = Math.min(Math.floor(rf), 4), fr = rf - Math.floor(rf);
      let a = lerp(base[ri], base[Math.min(ri + 1, 4)], fr) * (1 - sat(rf - (keep - 1)));
      if (l.hold) a = Math.max(a, l.hold);
      if (l.until) a *= 1 - sat((lt - l.t - l.until) / 0.9);
      if (a <= 0.005) continue;
      const y = cy - shift;
      const ll = lt - l.t - (i > 0 ? 0.32 : 0); // new words wait for the old line to clear its slot
      if (ll < 0) continue;
      const words = l.text.split(' ');
      const col = l.color || PAL.ink;
      if (l.mode === 'type') {
        const cps = l.cps || 30; const cnt = Math.floor(ll * cps);
        const shown = l.text.slice(0, cnt);
        const w = measure(c, l.text, st);
        const x0 = align === 'center' ? cx - w / 2 : cx;
        c.save(); c.globalAlpha = a;
        T(c, shown, x0, y, Object.assign({}, st, { align: 'left', color: col }));
        if (cnt < l.text.length + 30 && (Math.floor(ll * 2.4) % 2 === 0 || cnt < l.text.length)) {
          const sw = measure(c, shown, st);
          c.fillStyle = l.caret || PAL.gold; c.fillRect(x0 + sw + 4, y - st.size * 0.55, st.size * 0.5, st.size * 1.05);
        }
        c.restore();
        continue;
      }
      if (l.s === 'big' || l.s === 'huge') { // per-letter kinetic reveal
        const chars = Array.from(l.text), wTot = measure(c, l.text, st);
        let x = align === 'center' ? cx - wTot / 2 : cx;
        c.save();
        for (let k = 0; k < chars.length; k++) {
          const cw = measure(c, chars[k], st), p = sat((ll - k * 0.06) / 0.7), e = ease.outBack(p);
          if (p > 0 && chars[k] !== ' ') {
            c.globalAlpha = a * ease.outC(p);
            T(c, chars[k], x + cw / 2, y + (1 - e) * -50, Object.assign({}, st, { color: U.mix(col.startsWith('#') ? col : '#f3e9d2', '#ffffff', 1 - sat((ll - k * 0.06 - 0.3) / 0.8)), scale: 0.7 + 0.3 * e }));
          }
          x += cw;
        }
        c.restore();
        continue;
      }
      const sp = measure(c, ' ', st);
      const ws = words.map((w) => measure(c, w, st));
      const total = ws.reduce((s, v) => s + v, 0) + sp * (words.length - 1);
      let x = align === 'center' ? cx - total / 2 : cx;
      const wd = l.wd || 0.13;
      c.save();
      for (let k = 0; k < words.length; k++) {
        const p = sat((ll - k * wd) / 0.55);
        if (p > 0) {
          const e = ease.outC(p);
          const isAcc = l.acc && l.acc.split(' ').some((z) => words[k].toLowerCase().replace(/[^a-z0-9']/g, '') === z.toLowerCase());
          c.globalAlpha = a * e;
          const fresh = 1 - sat((ll - k * wd - 0.4) / 0.9);
          const wc = isAcc ? (l.accColor || PAL.gold) : (fresh > 0 ? U.mix(col.startsWith('#') ? col : '#f3e9d2', '#ffffff', fresh * 0.6) : col);
          T(c, words[k], x + ws[k] / 2, y + (1 - e) * 16, Object.assign({}, st, { color: wc, scale: 0.94 + 0.06 * e, spacing: (1 - e) * 3 }));
        }
        x += ws[k] + sp;
      }
      c.restore();
    }
  };

  // Terminal-ish typewriter block. rows: [{t, text, color, cps, prompt}] positioned from (x,y) with lh
  L.term = function (c, lt, rows, x, y, o = {}) {
    const size = o.size || 32, lh = o.lh || size * 1.55;
    const st = { font: 'JetBrains Mono', size, weight: 400 };
    let yy = y;
    let lastCaret = null;
    for (const r of rows) {
      if (lt < r.t) { continue; }
      const cps = r.cps || 34;
      const cnt = r.instant ? r.text.length : Math.floor((lt - r.t) * cps);
      const shown = r.text.slice(0, cnt);
      const px = r.prompt ? measure(c, r.prompt + ' ', st) : 0;
      if (r.prompt) T(c, r.prompt, x, yy, Object.assign({}, st, { align: 'left', color: PAL.gold }));
      T(c, shown, x + px, yy, Object.assign({}, st, { align: 'left', color: r.color || PAL.ink }));
      lastCaret = [x + px + measure(c, shown, st) + 3, yy, cnt < r.text.length];
      yy += lh * (r.gap || 1);
    }
    if (lastCaret && !o.nocaret) {
      const [cx2, cy2, typing] = lastCaret;
      if (typing || Math.floor(lt * 2.2) % 2 === 0) { c.fillStyle = PAL.gold; c.fillRect(cx2, cy2 - size * 0.55, size * 0.55, size * 1.05); }
    }
  };

  // ---- particle text ----
  const ptCache = {};
  function targets(text, size, font, weight, step) {
    const key = [text, size, font, weight, step].join('|');
    if (ptCache[key]) return ptCache[key];
    const cv = document.createElement('canvas'); cv.width = W; cv.height = 500;
    const g = cv.getContext('2d');
    g.font = `${weight} ${size}px "${font}"`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
    g.letterSpacing = Math.round(size * 0.04) + 'px';
    g.fillText(text, W / 2, 250);
    const d = g.getImageData(0, 0, W, 500).data;
    const pts = [];
    for (let y = 0; y < 500; y += step) for (let x = 0; x < W; x += step) { if (d[(y * W + x) * 4 + 3] > 140) pts.push([x - W / 2, y - 250]); }
    ptCache[key] = pts; return pts;
  }
  // o: {text,size,font,weight,cx,cy,t0,form,out,outDur,seed,step,colA,colB}
  L.particleText = function (c, lt, o) {
    const pts = targets(o.text, o.size, o.font || 'JetBrains Mono', o.weight || 700, o.step || 5);
    const r = rng(o.seed || 5);
    const t0 = o.t0 || 0, form = o.form || 2.2, out = o.out === undefined ? 1e9 : o.out, outDur = o.outDur || 1.6;
    const cx = o.cx === undefined ? W / 2 : o.cx, cy = o.cy === undefined ? H / 2 : o.cy;
    const ca = o.colA || PAL.gold, cb = o.colB || '#fff3d6';
    c.save();
    const buckets = [[], [], []];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const rr = r(), r2 = r(), r3 = r(), r4 = r();
      const ang = r2 * 6.283, dist = 500 + rr * 900;
      const sx = Math.cos(ang) * dist, sy = Math.sin(ang) * dist * 0.6;
      const delay = r3 * 0.8;
      let e = ease.outE(sat((lt - t0 - delay) / (form - 0.8)));
      const sw = Math.sin(e * Math.PI) * 120 * (r4 - 0.5);
      let x = lerp(sx, p[0], e) + sw, y = lerp(sy, p[1], e) - sw * 0.6;
      let al = 0.9 * sat((lt - t0 - delay) / 0.3);
      if (lt > out) {
        const k = sat((lt - out - r3 * 0.4) / outDur), ek = ease.inQ(k);
        x += Math.cos(ang) * 900 * ek + Math.sin(ang * 3) * 60 * k; y += Math.sin(ang) * 600 * ek - 120 * ek;
        al *= 1 - k;
      } else {
        // breathing shimmer when formed
        x += Math.sin(lt * 2 + i) * 1.1 * e; y += Math.cos(lt * 1.7 + i * 0.7) * 1.1 * e;
      }
      if (al <= 0.01) continue;
      const b = (p[0] / 900 + 0.5 + r4 * 0.3) * 2.99;
      buckets[Math.min(2, Math.max(0, Math.floor(b)))].push([cx + x, cy + y, al]);
    }
    const cols = [ca, U.mix(ca, cb, 0.5), cb];
    for (let b = 0; b < 3; b++) {
      c.fillStyle = cols[b];
      for (const q of buckets[b]) { c.globalAlpha = q[2]; c.fillRect(q[0] - 1.6, q[1] - 1.6, 3.2, 3.2); }
    }
    c.restore();
    return pts.length;
  };

  // sun-like soft glow orb
  L.orb = function (c, x, y, r, col, a = 1) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(col, a)); g.addColorStop(0.35, rgba(col, a * 0.35)); g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
  };

  L.count = function (from, to, p, e) { return Math.round(lerp(from, to, (e || ease.outC)(sat(p)))); };
})();
