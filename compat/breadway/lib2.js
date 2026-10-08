// Data-viz + illustrative components.
(function () {
  const { W, H, PAL, clamp, sat, lerp, seg, ease, rng, T, rgba, measure, fmt } = U;
  const L = window.L;

  // ---------- radial 24h commit clock ----------
  L.radial = function (c, lt, o) {
    const D = DATA, cx = o.cx, cy = o.cy, r0 = o.r0 || 150, rmax = o.rmax || 330, t0 = o.t0 || 0;
    const max = Math.max(...D.hour);
    c.save();
    // rings
    for (let k = 0; k < 4; k++) {
      c.strokeStyle = 'rgba(243,233,210,0.07)'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(cx, cy, r0 + (rmax - r0) * (k + 1) / 4, 0, 7); c.stroke();
    }
    c.strokeStyle = 'rgba(243,233,210,0.22)'; c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, r0 - 8, 0, 7); c.stroke();
    for (let i = 0; i < 24; i++) {
      const ang = (i / 24) * Math.PI * 2 - Math.PI / 2;
      const e = ease.outBack(sat((lt - t0 - i * 0.055) / 1.0));
      const len = (rmax - r0) * (D.hour[i] / max) * e + 4;
      const night = i < 6 || i >= 23;
      const inten = D.hour[i] / max;
      const col = night ? U.mix('#4a6ea8', '#a9c8ff', inten) : U.mix('#9a6a2c', '#ffe3a6', inten);
      const x1 = cx + Math.cos(ang) * r0, y1 = cy + Math.sin(ang) * r0;
      const x2 = cx + Math.cos(ang) * (r0 + len), y2 = cy + Math.sin(ang) * (r0 + len);
      c.strokeStyle = col; c.lineWidth = 17; c.lineCap = 'round';
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      if (inten > 0.85 && e > 0.9) { L.orb(c, x2, y2, 60, '#ffe3a6', 0.55 * (0.7 + 0.3 * Math.sin(lt * 3 + i))); }
    }
    // labels
    const lab = [['00', 0], ['06', 6], ['12', 12], ['18', 18]];
    for (const [s, h] of lab) {
      const ang = (h / 24) * Math.PI * 2 - Math.PI / 2, rr = r0 - 44;
      T(c, s, cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, { font: 'JetBrains Mono', size: 26, color: '#a89f8c', spacing: 2 });
    }
    // sweeping hand
    const hand = (lt * 0.5) % 1 * Math.PI * 2 - Math.PI / 2;
    for (let k = 0; k < 14; k++) {
      c.strokeStyle = `rgba(243,233,210,${0.16 * (1 - k / 14)})`; c.lineWidth = 2;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(hand - k * 0.03) * (rmax + 24), cy + Math.sin(hand - k * 0.03) * (rmax + 24)); c.stroke();
    }
    c.restore();
  };

  // ---------- calendar heatmap ----------
  L.calendar = function (c, lt, o) {
    const D = DATA, cell = o.cell || 40, gap = o.gap || 9, t0 = o.t0 || 0;
    const cols = D.nweeks, w = cols * (cell + gap) - gap, h = 7 * (cell + gap) - gap;
    const x0 = o.x === undefined ? (W - w) / 2 : o.x, y0 = o.y;
    const max = D.maxDay;
    c.save();
    const dnames = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    for (let r = 0; r < 7; r++) T(c, dnames[r], x0 - 34, y0 + r * (cell + gap) + cell / 2, { font: 'JetBrains Mono', size: 22, color: PAL.dim, alpha: sat((lt - t0) / 0.8) });
    let best = null;
    for (let i = 0; i < D.cal.length; i++) {
      const col = Math.floor(i / 7), row = i % 7; // d0 is a Monday
      const [date, n] = D.cal[i];
      const ap = t0 + col * 0.09 + row * 0.02;
      const p = sat((lt - ap) / 0.5); if (p <= 0) continue;
      const e = ease.outBack(p);
      const x = x0 + col * (cell + gap), y = y0 + row * (cell + gap);
      const inten = n ? 0.16 + 0.84 * Math.pow(n / max, 0.6) : 0;
      c.globalAlpha = p;
      c.fillStyle = n ? U.mix('#5a3d18', '#ffe3a6', inten) : 'rgba(243,233,210,0.07)';
      const s = cell * (0.4 + 0.6 * e);
      U.roundRect(c, x + (cell - s) / 2, y + (cell - s) / 2, s, s, 8); c.fill();
      if (n === max) best = [x + cell / 2, y + cell / 2, n, date];
    }
    c.globalAlpha = 1;
    // month labels
    const months = ['MAY', 'JUN', 'JUL', 'AUG', 'SEP'];
    const d0 = new Date(D.start + 'T00:00:00Z');
    for (let m = 0; m < 5; m++) {
      const first = new Date(Date.UTC(2026, 4 + m, 1));
      const idx = Math.max(0, Math.round((first - d0) / 86400000));
      const col = Math.floor(idx / 7);
      T(c, months[m], x0 + col * (cell + gap), y0 + h + 38, { font: 'JetBrains Mono', size: 22, spacing: 4, color: PAL.dim, align: 'left', alpha: sat((lt - t0 - col * 0.09) / 0.6) });
    }
    if (best && lt > o.hl) {
      const k = sat((lt - o.hl) / 0.9);
      const pul = (lt - o.hl) % 1.6 / 1.6;
      c.strokeStyle = rgba(PAL.gold, (1 - pul) * 0.8); c.lineWidth = 3;
      c.beginPath(); c.arc(best[0], best[1], 24 + pul * 60, 0, 7); c.stroke();
      c.globalAlpha = k;
      T(c, `${best[2]} commits in one day`, best[0], best[1] - 84, { font: 'JetBrains Mono', size: 28, color: PAL.gold });
      c.strokeStyle = rgba(PAL.gold, 0.7); c.lineWidth = 2; c.beginPath(); c.moveTo(best[0], best[1] - 68); c.lineTo(best[0], best[1] - 30); c.stroke();
    }
    c.restore();
    return { w, h, x0 };
  };

  // ---------- ridgeline (joy-division style), one ridge per repo ----------
  L.ridge = function (c, lt, o) {
    const D = DATA, names = D.top.map((t) => t[0]);
    const n = names.length, x0 = o.x0, x1 = o.x1, y0 = o.y0, gapY = o.gap, t0 = o.t0 || 0;
    const sweep = ease.inOutC(sat((lt - t0) / (o.sweep || 6)));
    const ptsPerWeek = 5;
    const maxv = Math.max(...names.map((k) => Math.max(...D.ridge[k])));
    c.save();
    for (let i = 0; i < n; i++) {
      const name = names[i], arr = D.ridge[name];
      const by = y0 + i * gapY;
      const pts = [];
      const N = (arr.length - 1) * ptsPerWeek;
      for (let k = 0; k <= N; k++) {
        const wk = k / ptsPerWeek, i0 = Math.floor(wk), f = wk - i0;
        const v = lerp(arr[i0], arr[Math.min(arr.length - 1, i0 + 1)], f * f * (3 - 2 * f));
        const x = lerp(x0, x1, k / N);
        const rise = ease.outC(sat((lt - t0 - i * 0.12 - (k / N) * 1.2) / 1.6));
        const vis = k / N <= sweep + 0.001;
        const hgt = (v / maxv) * o.amp * rise * (vis ? 1 : 0);
        pts.push([x, by - hgt + (1 - rise) * 20 + U.noise(k * 0.9 + i * 13) * 2.2 * rise]);
      }
      const hue = i / (n - 1);
      const col = U.mix('#f3e9d2', i % 3 === 0 ? '#e6b25e' : i % 3 === 1 ? '#7fb4ff' : '#5fd0c0', 0.55 + 0.4 * (1 - hue));
      // fill to hide lines behind
      c.beginPath(); U.smoothPath(c, pts); c.lineTo(x1, by + gapY * 0.6); c.lineTo(x0, by + gapY * 0.6); c.closePath();
      c.fillStyle = 'rgba(7,7,7,0.94)'; c.fill();
      c.beginPath(); U.smoothPath(c, pts); c.strokeStyle = col; c.lineWidth = 2.2; c.globalAlpha = sat((lt - t0 - i * 0.12) / 0.5); c.stroke(); c.globalAlpha = 1;
      T(c, name, x0 - 22, by - 6, { font: 'JetBrains Mono', size: 20, color: PAL.dim, align: 'right', alpha: sat((lt - t0 - i * 0.12) / 0.6) });
    }
    // sweep cursor
    const sx = lerp(x0, x1, sweep);
    if (sweep > 0.001 && sweep < 0.999) {
      const g = c.createLinearGradient(sx - 90, 0, sx, 0); g.addColorStop(0, 'rgba(230,178,94,0)'); g.addColorStop(1, 'rgba(230,178,94,0.22)');
      c.fillStyle = g; c.fillRect(sx - 90, y0 - o.amp - 20, 90, gapY * n + o.amp + 20);
    }
    c.restore();
    return sweep;
  };

  // ---------- Astra progress chart ----------
  L.astra = function (c, lt, o) {
    const x0 = o.x0, y0 = o.y0, w = o.w, h = o.h, t0 = o.t0 || 0;
    const ymax = 70;
    const X = (i) => x0 + (i / 3) * w, Y = (v) => y0 + h - (v / ymax) * h;
    c.save();
    // grid
    for (let v = 0; v <= 60; v += 20) {
      const y = Y(v);
      c.strokeStyle = 'rgba(243,233,210,0.09)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x0 - 30, y); c.lineTo(x0 + w + 40, y); c.stroke();
      T(c, v + '%', x0 - 46, y, { font: 'JetBrains Mono', size: 22, color: PAL.dim, align: 'right' });
    }
    // target band
    const bp = sat((lt - t0 - 0.2) / 0.8);
    c.fillStyle = rgba(PAL.teal, 0.10 * bp); c.fillRect(x0 - 30, Y(65), w + 70, Y(55) - Y(65));
    c.setLineDash([10, 10]); c.strokeStyle = rgba(PAL.teal, 0.6 * bp); c.lineWidth = 1.5;
    c.strokeRect(x0 - 30, Y(65), w + 70, Y(55) - Y(65)); c.setLineDash([]);
    T(c, 'TARGET 55 TO 65', x0 + w + 36, Y(65) - 18, { font: 'JetBrains Mono', size: 16, spacing: 3, color: rgba(PAL.teal, 0.9 * bp), align: 'right' });
    const pts = [[X(0), Y(26.0)], [X(1), Y(43.6)], [X(2), Y(43.8)], [X(3), Y(38.7)]];
    const labels = ['ASTRA-1', 'ASTRA-2', 'ASTRA-3', 'ASTRA-6'];
    const vals = ['26.0%', '43.6%', '43.8%', '38.7%'];
    const prog = sat((lt - t0 - 0.8) / 4.2);
    // line
    const segs = 3, f = prog * segs;
    c.strokeStyle = PAL.gold; c.lineWidth = 4; c.lineCap = 'round'; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < segs; i++) {
      const p = clamp(f - i, 0, 1); if (p <= 0) break;
      c.lineTo(lerp(pts[i][0], pts[i + 1][0], p), lerp(pts[i][1], pts[i + 1][1], p));
    }
    c.stroke();
    for (let i = 0; i < 4; i++) {
      const p = sat((f - (i - 0.15)) / 0.4); if (i > 0 && p <= 0) continue;
      const e = i === 0 ? sat((lt - t0 - 0.6) / 0.5) : ease.outBack(p);
      L.orb(c, pts[i][0], pts[i][1], 46 * e, PAL.gold, 0.5);
      c.fillStyle = '#fff1cc'; c.beginPath(); c.arc(pts[i][0], pts[i][1], 9 * e, 0, 7); c.fill();
      c.globalAlpha = e;
      T(c, vals[i], pts[i][0], pts[i][1] - 44, { font: 'JetBrains Mono', size: 30, weight: 700, color: PAL.ink });
      T(c, labels[i], pts[i][0], y0 + h + 40, { font: 'JetBrains Mono', size: 22, spacing: 4, color: PAL.dim });
      c.globalAlpha = 1;
    }
    // hybrid marker at v6
    const hp = sat((lt - t0 - 5.6) / 0.6);
    if (hp > 0) {
      const hx = X(3) + 70, hy = Y(42.0);
      c.globalAlpha = hp;
      c.strokeStyle = PAL.blue; c.lineWidth = 3; c.setLineDash([6, 6]); c.beginPath(); c.moveTo(pts[3][0], pts[3][1]); c.lineTo(hx, hy); c.stroke(); c.setLineDash([]);
      c.fillStyle = PAL.blue; c.beginPath(); c.arc(hx, hy, 9, 0, 7); c.fill();
      T(c, '42.0%', hx + 22, hy - 4, { font: 'JetBrains Mono', size: 26, weight: 700, color: PAL.blue, align: 'left' });
      T(c, 'hybrid', hx + 22, hy + 26, { font: 'JetBrains Mono', size: 16, spacing: 3, color: PAL.blue, align: 'left' });
      c.globalAlpha = 1;
    }
    c.restore();
  };

  // ---------- bits demo ----------
  function bitRow(c, str, x, y, cell, gap, o = {}) {
    const n = str.length, w = n * (cell + gap) - gap, ga = c.globalAlpha;
    let xx = x - w / 2;
    for (let i = 0; i < n; i++) {
      const on = str[i] === '1';
      const hl = o.lit ? o.lit(i) : 1;
      const fade = o.fade ? o.fade(i) : 1;
      c.globalAlpha = ga * fade * (o.alpha === undefined ? 1 : o.alpha);
      const col = o.col ? o.col(i, on) : (on ? PAL.gold : 'rgba(243,233,210,0.10)');
      c.fillStyle = col; U.roundRect(c, xx, y - cell / 2, cell, cell, 10); c.fill();
      T(c, str[i], xx + cell / 2, y + 2, { font: 'JetBrains Mono', size: cell * 0.5, weight: 700, color: on ? '#1a1206' : PAL.dim });
      xx += cell + gap;
    }
    c.globalAlpha = ga;
    return { x0: x - w / 2, w };
  }
  L.bitRow = bitRow;

  L.bits = function (c, lt) {
    const cell = 84, gap = 12, cx = W / 2;
    const pad = (v, n = 8) => v.toString(2).padStart(n, '0');
    const lab = (s, x, y, col, a) => T(c, s, x, y, { font: 'JetBrains Mono', size: 28, color: col || PAL.dim, align: 'right', alpha: a });
    c.save();
    if (lt < 12.5) {
      c.globalAlpha = sat((12.4 - lt) / 0.6);
      // A: mask
      const x = 182, m = 15;
      const a1 = sat(lt / 0.6);
      const r1 = bitRow(c, pad(x), cx + 120, 330, cell, gap, { alpha: a1 });
      lab('x', r1.x0 - 40, 330, PAL.ink, a1);
      const a2 = sat((lt - 1.2) / 0.6);
      const r2 = bitRow(c, pad(m), cx + 120, 470, cell, gap, { alpha: a2, col: (i, on) => (on ? PAL.blue : 'rgba(243,233,210,0.10)') });
      lab('(1 << 4) - 1', r2.x0 - 40, 470, PAL.blue, a2);
      const a3 = sat((lt - 3.2) / 0.6);
      const res = pad(x & m);
      // sweep connect
      if (a3 > 0) {
        for (let i = 0; i < 8; i++) {
          const both = pad(x)[i] === '1' && pad(m)[i] === '1';
          const xx = r1.x0 + i * (cell + gap) + cell / 2;
          c.strokeStyle = both ? rgba(PAL.gold, 0.7 * a3) : 'rgba(243,233,210,0.08)'; c.lineWidth = 2;
          c.beginPath(); c.moveTo(xx, 372); c.lineTo(xx, 596 - 42); c.stroke();
        }
      }
      const r3 = bitRow(c, res, cx + 120, 610, cell, gap, { alpha: a3, col: (i, on) => (on ? PAL.green : 'rgba(243,233,210,0.10)') });
      lab('x & mask', r3.x0 - 40, 610, PAL.green, a3);
      // caption
      T(c, 'a mask keeps the bits you ask for', cx, 800, { size: 46, italic: 1, style: 'italic', weight: 300, alpha: sat((lt - 4.5) / 0.8) * sat((12.5 - lt) / 0.6), color: PAL.ink });
    } else if (lt < 25) {
      const k = lt - 12.5;
      // B: overflow in 8 bits
      const low = 200, high = 250;
      const a = sat(k / 0.6);
      T(c, 'low = 200   high = 250   (uint8)', cx, 214, { font: 'JetBrains Mono', size: 30, color: PAL.dim, alpha: a });
      const r1 = bitRow(c, pad(low), cx + 150, 330, 74, 10, { alpha: a });
      lab('low', r1.x0 - 34, 330, PAL.ink, a);
      const a2 = sat((k - 1) / 0.6);
      const r2 = bitRow(c, pad(high), cx + 150, 430, 74, 10, { alpha: a2 });
      lab('high', r2.x0 - 34, 430, PAL.ink, a2);
      const a3 = sat((k - 2.5) / 0.6);
      const sum = low + high; // 450 -> 9 bits
      const full = pad(sum, 9);
      const fall = ease.inQ(sat((k - 4.6) / 1.6));
      if (a3 > 0) {
        // carry bit (leftmost of 9) sits outside the 8-bit register
        const w8 = 8 * (74 + 10) - 10;
        const x8 = cx + 150 - w8 / 2;
        c.strokeStyle = rgba(PAL.blue, 0.35 * a3); c.lineWidth = 2; c.setLineDash([8, 8]);
        U.roundRect(c, x8 - 8, 552 - 8 - 40, w8 + 16, 74 + 16 + 16, 14); c.stroke(); c.setLineDash([]);
        T(c, '8-bit register', x8 + w8, 552 - 62, { font: 'JetBrains Mono', size: 16, spacing: 3, color: rgba(PAL.blue, 0.9 * a3), align: 'right' });
        // low+high
        const lowerBits = full.slice(1);
        bitRow(c, lowerBits, cx + 150, 552, 74, 10, { alpha: a3, col: (i, on) => (on ? (fall > 0 ? U.mix('#e6b25e', '#e5484d', fall) : PAL.gold) : 'rgba(243,233,210,0.10)') });
        const cbx = x8 - 84, cby = 552 + fall * 240;
        c.globalAlpha = a3 * (1 - fall * 0.85);
        c.fillStyle = PAL.red; U.roundRect(c, cbx, cby - 37, 74, 74, 10); c.fill();
        T(c, full[0], cbx + 37, cby + 2, { font: 'JetBrains Mono', size: 37, weight: 700, color: '#1a0606' });
        c.globalAlpha = 1;
        lab('low + high', x8 - 110, 552, PAL.ink, a3);
        const a4 = sat((k - 5.6) / 0.5);
        T(c, `${sum} wraps to ${sum & 255}`, cx, 686, { font: 'JetBrains Mono', size: 34, weight: 700, color: PAL.red, alpha: a4 });
        T(c, `${sum & 255} is below low. the midpoint left the range.`, cx, 736, { font: 'JetBrains Mono', size: 24, color: PAL.dim, alpha: a4 });
      }
      const a5 = sat((k - 8.4) / 0.7);
      if (a5 > 0) {
        c.globalAlpha = a5;
        const mid = low + ((high - low) >> 1);
        const rr = bitRow(c, pad(mid), cx + 150, 850, 74, 10, { col: (i, on) => (on ? PAL.green : 'rgba(243,233,210,0.10)') });
        lab('low + (high - low) / 2', rr.x0 - 34, 850, PAL.green, 1);
        T(c, `= ${mid}`, cx + 150 + 8 * 42 + 44, 850, { font: 'JetBrains Mono', size: 34, weight: 700, color: PAL.green, align: 'left' });
        c.globalAlpha = 1;
      }
    }
    c.restore();
  };

  // ---------- ocean horizon ----------
  L.ocean = function (c, lt, o) {
    const hy = o.hy || 560, N = 44, sunP = ease.inOutC(sat((lt - (o.sunT || 0)) / (o.sunDur || 14)));
    const sx = W / 2, sy = hy + 60 - sunP * 150;
    const amp = o.amp === undefined ? 1 : o.amp;
    c.save();
    // sky
    const g = c.createLinearGradient(0, 0, 0, hy);
    g.addColorStop(0, 'rgba(6,6,10,0)'); g.addColorStop(1, `rgba(${Math.round(120 + 60 * sunP)},${Math.round(70 + 30 * sunP)},40,${0.10 + 0.32 * sunP})`);
    c.fillStyle = g; c.fillRect(0, 0, W, hy);
    L.dust(c, lt, 71, 70, { alpha: 0.55 * (1 - sunP * 0.7), vy: 1.5, vx: 2 });
    // sun
    if (sunP > 0) {
      c.save(); c.beginPath(); c.rect(0, 0, W, hy); c.clip();
      L.orb(c, sx, sy, 380, '#ffb35a', 0.5 * sunP);
      c.fillStyle = 'rgba(255,240,205,1)'; c.beginPath(); c.arc(sx, sy, 15 + 10 * sunP, 0, 7); c.fill();
      c.restore();
    }
    // sea lines
    for (let k = 0; k < N; k++) {
      const f = k / (N - 1), yb = hy + (H - hy + 60) * Math.pow(f, 2.1);
      const A = (2 + 46 * Math.pow(f, 1.9)) * amp;
      const pts = [];
      for (let x = -40; x <= W + 40; x += 32) {
        const ph = lt * (0.7 + f * 0.5);
        const y = yb + A * (Math.sin(x * 0.0042 + ph + k * 0.7) * 0.6 + Math.sin(x * 0.0091 - ph * 1.3 + k * 1.9) * 0.35 + Math.sin(x * 0.0021 + ph * 0.4) * 0.5);
        const glint = Math.exp(-Math.pow((x - sx) / (60 + f * 380), 2)) * sunP;
        pts.push([x, y, glint]);
      }
      // dark body fill under line to occlude far lines
      c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts) c.lineTo(p[0], p[1]);
      c.lineTo(W + 40, H + 60); c.lineTo(-40, H + 60); c.closePath();
      c.fillStyle = 'rgba(7,7,8,0.96)'; c.fill();
      // stroke in segments to vary brightness with sun glint
      for (let i = 0; i < pts.length - 1; i++) {
        const gl = (pts[i][2] + pts[i + 1][2]) / 2;
        const a = 0.10 + 0.5 * f + gl * (0.4 + 0.6 * f);
        c.strokeStyle = gl > 0.05 ? U.mix('#b98a55', '#fff0cc', clamp(gl, 0, 1)) : `rgba(201,170,120,${a})`;
        c.globalAlpha = clamp(a, 0, 1) * sat((lt - (o.t0 || 0) - k * 0.03) / 1.2);
        c.lineWidth = 1 + f * 2.2 + gl * 2;
        c.beginPath(); c.moveTo(pts[i][0], pts[i][1]); c.lineTo(pts[i + 1][0], pts[i + 1][1]); c.stroke();
      }
      c.globalAlpha = 1;
    }
    c.restore();
    return { sx, sy, sunP };
  };

  // ---------- flying word field ----------
  L.wordfield = function (c, lt, o) {
    const words = o.words, r = rng(o.seed || 3), sp = o.speed || 0.06;
    const cx = W / 2, cy = H / 2 - 20;
    c.save();
    const n = o.n || 130;
    const items = [];
    for (let i = 0; i < n; i++) {
      const w = words[Math.floor(r() * words.length)];
      const ang = r() * 6.283, rad = 0.18 + Math.sqrt(r()) * 1.15;
      const z0 = r(), hot = r() < 0.16;
      items.push({ w, ang, rad, z0, hot, ph: r() * 6.28 });
    }
    items.forEach((it) => {
      const z = 1 - (((it.z0 + lt * sp) % 1 + 1) % 1); // 1 far -> 0 near
      const persp = 1 / (0.12 + z * 1.1);
      const x = cx + Math.cos(it.ang + lt * 0.02) * it.rad * 620 * persp * 0.55;
      const y = cy + Math.sin(it.ang + lt * 0.02) * it.rad * 380 * persp * 0.55;
      const size = 20 * persp * (it.hot ? 1.3 : 1);
      if (size < 6 || size > 190) return;
      const near = sat((0.18 - (1 - z) * 0 - (z)) / 0.18); // fade as it comes very near (z small)
      const a = (it.hot ? 0.95 : 0.55) * sat(z / 0.25) * sat((1 - z) / 0.15) * (o.alpha === undefined ? 1 : o.alpha) * (0.5 + 0.5 * Math.sin(lt * 0.8 + it.ph));
      if (a < 0.02) return;
      const fam = it.hot ? 'Newsreader' : 'JetBrains Mono';
      T(c, it.w, x, y, { font: fam, size, style: it.hot ? 'italic' : 'normal', weight: 400, color: it.hot ? PAL.gold : '#cfc7b4', alpha: a });
    });
    c.restore();
  };
})();
