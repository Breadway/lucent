// Components v6: relationship curve, result charts, priorities orbit, breath orb, quote cards.
(function () {
  const { W, H, PAL, sat, lerp, ease, T, rgba, rng } = U;
  const L = window.L;
  const MONO = { font: 'JetBrains Mono' };
  const clampi = (v, a, b) => Math.max(a, Math.min(b, v));

  L.wrapText = function (c, text, maxW, st) {
    const words = text.split(' '), out = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (U.measure(c, t, st) > maxW && cur) { out.push(cur); cur = w; } else cur = t;
    }
    if (cur) out.push(cur);
    return out;
  };

  // ---------- closeness over time ----------
  // o: {x0,x1,y0,y1, months, pts:[{m,v,t,date,label,big}], startIdx}
  // Points before startIdx are history (dim, fully drawn). The head then travels point to point on the pts' t.
  const cr = (p0, p1, p2, p3, t) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  L.closeness = function (c, lt, o) {
    const A0 = c.globalAlpha;
    const N = o.months || 17, X = (m) => lerp(o.x0, o.x1, m / N), Y = (v) => lerp(o.y1, o.y0, v);
    const n = o.pts.length, P = o.pts.map((p) => [X(p.m), Y(p.v)]), si = o.startIdx || 0;
    const hx = (n) => Math.round(n).toString(16).padStart(2, '0');
    const col = (v) => { const k = clampi(v, 0, 1), A = [127, 180, 255], B = [242, 200, 119]; return '#' + hx(lerp(A[0], B[0], k)) + hx(lerp(A[1], B[1], k)) + hx(lerp(A[2], B[2], k)); };
    const ay = o.y1 + 52;
    c.save();
    // axis
    c.strokeStyle = 'rgba(243,233,210,0.2)'; c.lineWidth = 2; c.beginPath(); c.moveTo(o.x0, ay); c.lineTo(o.x1, ay); c.stroke();
    const MN = 'JFMAMJJASONDJFMAM';
    for (let i = 0; i < N; i++) {
      T(c, MN[i % MN.length], X(i + 0.5), ay + 30, Object.assign({ size: 22, color: '#8d8676' }, MONO));
      c.beginPath(); c.moveTo(X(i), ay - 6); c.lineTo(X(i), ay + 6); c.stroke();
    }
    c.setLineDash([4, 9]); c.strokeStyle = 'rgba(243,233,210,0.10)'; c.beginPath(); c.moveTo(X(12), o.y0 - 40); c.lineTo(X(12), ay); c.stroke(); c.setLineDash([]);
    T(c, 'CLOSE', 64, Y(0.95), Object.assign({ size: 18, spacing: 4, color: '#8d8676', align: 'left' }, MONO));
    T(c, 'FAR', 64, Y(0.02), Object.assign({ size: 18, spacing: 4, color: '#8d8676', align: 'left' }, MONO));
    // head position
    const t0 = o.pts[si].t, tEnd = o.pts[n - 1].t;
    let hi = si, tau = 0, started = lt >= t0 || si > 0;
    if (lt >= tEnd) { hi = n - 2; tau = 1; }
    else if (lt >= t0) { hi = si; while (hi < n - 2 && lt >= o.pts[hi + 1].t) hi++; tau = ease.inOutS(sat((lt - o.pts[hi].t) / (o.pts[hi + 1].t - o.pts[hi].t))); }
    else { hi = si; tau = 0; }
    const segPt = (i, k) => {
      const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n - 1, i + 2)];
      return [cr(p0[0], p1[0], p2[0], p3[0], k), cr(p0[1], p1[1], p2[1], p3[1], k)];
    };
    // curve: history dim, then live part bright
    const STEP = 22;
    const stroke = (i, kEnd, dim) => {
      let prev = segPt(i, 0);
      const cnt = Math.max(1, Math.ceil(STEP * kEnd));
      for (let s = 1; s <= cnt; s++) {
        const k = Math.min(kEnd, s / STEP), q = segPt(i, k), v = lerp(o.pts[i].v, o.pts[i + 1].v, k);
        c.beginPath(); c.moveTo(prev[0], prev[1]); c.lineTo(q[0], q[1]);
        c.lineCap = 'round';
        if (!dim) { c.strokeStyle = rgba(col(v), 0.14); c.lineWidth = 14; c.stroke(); }
        c.strokeStyle = rgba(col(v), dim ? 0.42 : 0.95); c.lineWidth = dim ? 3 : 4.5; c.stroke();
        prev = q;
      }
    };
    if (started) {
      for (let i = 0; i < si && i < n - 1; i++) stroke(i, 1, true);
      for (let i = si; i < hi; i++) stroke(i, 1, false);
      if (hi < n - 1) stroke(hi, tau, false);
    }
    // dots + labels
    o.pts.forEach((p, i) => {
      const hist = i < si; if (!hist && lt < p.t - 0.05) return;
      const age = hist ? 99 : lt - p.t, a = hist ? 0.35 : ease.outC(sat(age / 0.5));
      const [px, py] = P[i], r = (p.big ? 10 : 6.5) * (hist ? 0.8 : 1);
      c.globalAlpha = A0 * (a); c.fillStyle = col(p.v); c.beginPath(); c.arc(px, py, r, 0, 7); c.fill();
      if (!hist && age < 1.6) { c.strokeStyle = rgba(col(p.v), 1 - age / 1.6); c.lineWidth = 2.5; c.beginPath(); c.arc(px, py, r + 6 + age * 34, 0, 7); c.stroke(); }
      if (hist) { c.globalAlpha = A0; return; }
      const la = ease.outC(sat(age / 0.6)) * (p.keep ? 1 : 1 - sat((age - 5.2) / 1.2));
      const lines = p.label ? L.wrapText(c, p.label, 300, { size: 34, style: 'italic', weight: 300 }) : [];
      const dir = p.dir || (p.v >= 0.5 ? 1 : -1), LH = 38, nl = lines.length;
      c.globalAlpha = A0 * (a * (p.date ? 0.55 : 0) * (p.keep ? 1 : 1 - sat((age - 5.2) / 1.2)));
      const dy = dir > 0 ? py + 44 : py - 44 - nl * LH;
      if (p.date) T(c, p.date, px, dy, Object.assign({ size: 20, spacing: 3, color: '#e6b25e' }, MONO));
      c.globalAlpha = A0 * (la);
      lines.forEach((ln, k) => {
        const y = dir > 0 ? py + 44 + (k + 1) * LH : py - 44 - (nl - k - 1) * LH;
        T(c, ln, clampi(px, 240, W - 240), y, { size: 34, style: 'italic', weight: 300, color: '#e8dfc9' });
      });
      c.globalAlpha = A0;
    });
    // head glow
    if (started) {
      const q = hi < n - 1 ? segPt(hi, tau) : P[n - 1], v = lerp(o.pts[hi].v, o.pts[Math.min(n - 1, hi + 1)].v, tau);
      L.orb(c, q[0], q[1], 60, col(v), 0.75);
      c.fillStyle = '#fff'; c.beginPath(); c.arc(q[0], q[1], 5, 0, 7); c.fill();
      c.strokeStyle = 'rgba(243,233,210,0.12)'; c.setLineDash([3, 8]); c.lineWidth = 1.5; c.beginPath(); c.moveTo(q[0], q[1] + 12); c.lineTo(q[0], ay); c.stroke(); c.setLineDash([]);
      o._head = { x: q[0], y: q[1], v };
    } else o._head = { x: P[si][0], y: P[si][1], v: o.pts[si].v };
    c.restore();
    return o._head;
  };

  // two orbs whose separation follows a closeness value (0..1)
  L.pair = function (c, lt, o) {
    const A0 = c.globalAlpha;
    const v = o.v, gap = lerp(430, 34, ease.inOutS(clampi(v, 0, 1))), a = o.a === undefined ? 1 : o.a;
    const bob = Math.sin(lt * 1.3) * 5;
    c.save(); c.globalAlpha = A0 * (a);
    const xa = o.cx - gap / 2, xb = o.cx + gap / 2;
    L.orb(c, xa, o.cy + bob, 70, PAL.blue, 0.55); L.orb(c, xb, o.cy - bob, 70, '#f2c877', 0.55);
    c.fillStyle = '#eaf2ff'; c.beginPath(); c.arc(xa, o.cy + bob, 9, 0, 7); c.fill();
    c.fillStyle = '#fff1cc'; c.beginPath(); c.arc(xb, o.cy - bob, 9, 0, 7); c.fill();
    if (gap < 120) { c.globalAlpha = A0 * (a * (1 - gap / 120) * 0.4); L.orb(c, o.cx, o.cy, 140, '#f2c877', 0.6); }
    c.globalAlpha = A0 * (a * 0.6 * sat((gap - 90) / 70));
    T(c, 'YOU', xa, o.cy + 46, Object.assign({ size: 16, spacing: 4, color: '#a9c8ff' }, MONO));
    T(c, 'HER', xb, o.cy + 46, Object.assign({ size: 16, spacing: 4, color: '#f2c877' }, MONO));
    c.restore();
  };

  // ---------- result charts ----------
  const N2 = (x, d) => x.toFixed(d);
  // long jump: o = {t0, x0, gy, scale, attempts:[{t,d}], next:{t,d}, best}
  L.jumpPit = function (c, lt, o) {
    const A0 = c.globalAlpha;
    const X = (m) => o.x0 + m * o.scale, gy = o.gy;
    c.save();
    // runway + pit
    c.strokeStyle = 'rgba(243,233,210,0.22)'; c.lineWidth = 2; c.beginPath(); c.moveTo(o.x0 - 300, gy); c.lineTo(X(7.4), gy); c.stroke();
    const pa = sat((lt - o.t0) / 1.2);
    c.globalAlpha = A0 * (pa);
    const sand = c.createLinearGradient(0, gy, 0, gy + 40); sand.addColorStop(0, 'rgba(230,178,94,0.30)'); sand.addColorStop(1, 'rgba(230,178,94,0.04)');
    c.fillStyle = sand; c.fillRect(X(4.4), gy, X(7.1) - X(4.4), 40);
    for (let m = 5; m <= 7; m++) { c.strokeStyle = 'rgba(243,233,210,0.35)'; c.beginPath(); c.moveTo(X(m), gy - 8); c.lineTo(X(m), gy + 8); c.stroke(); T(c, m + ' m', X(m), gy + 62, Object.assign({ size: 22, color: '#8d8676' }, MONO)); }
    // take-off board
    c.fillStyle = '#f3e9d2'; c.fillRect(o.x0 - 4, gy - 2, 8, 6); T(c, 'BOARD', o.x0, gy + 62, Object.assign({ size: 18, spacing: 4, color: '#8d8676' }, MONO));
    c.globalAlpha = A0;
    // attempts
    o.attempts.forEach((a, i) => {
      if (lt >= a.t - 1.5 && lt < a.t) { // run-up along the runway
        const u = ease.inQ(sat((lt - (a.t - 1.5)) / 1.5)), rx = lerp(o.x0 - 300, o.x0, u);
        c.globalAlpha = A0 * sat((lt - (a.t - 1.5)) / 0.3); c.fillStyle = '#f3e9d2';
        for (let k = 0; k < 6; k++) { c.globalAlpha = A0 * 0.5 * (1 - k / 6) * sat((lt - (a.t - 1.5)) / 0.3); c.beginPath(); c.arc(rx - k * 12, gy - 6, 6 - k * 0.7, 0, 7); c.fill(); }
        c.globalAlpha = A0;
      }
      if (lt < a.t) return;
      const fl = sat((lt - a.t) / 1.25), land = fl >= 1, age = lt - a.t - 1.25;
      const isBest = i === o.attempts.length - 1, hgt = 165 + i * 34;
      const arc = (u) => [lerp(o.x0, X(a.d), u), gy - 4 * hgt * u * (1 - u)];
      const steps = 40, upto = Math.floor(steps * ease.outQ(fl));
      c.lineWidth = isBest && land ? 4 : 2.5;
      c.strokeStyle = isBest && land ? rgba(PAL.gold, 0.95) : rgba('#f3e9d2', land ? 0.3 : 0.6);
      c.beginPath(); for (let s = 0; s <= upto; s++) { const q = arc(s / steps); s ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); } c.stroke();
      if (!land) { const q = arc(ease.outQ(fl)); L.orb(c, q[0], q[1], 34, PAL.gold, 0.8); c.fillStyle = '#fff'; c.beginPath(); c.arc(q[0], q[1], 6, 0, 7); c.fill(); }
      else {
        const ka = ease.outC(sat(age / 0.5));
        c.globalAlpha = A0 * (ka); c.fillStyle = isBest ? PAL.gold : '#cfc7b4'; c.beginPath(); c.arc(X(a.d), gy, isBest ? 9 : 6, 0, 7); c.fill();
        if (age < 1.4) { c.strokeStyle = rgba(PAL.gold, 1 - age / 1.4); c.lineWidth = 2; c.beginPath(); c.arc(X(a.d), gy, 10 + age * 40, 0, 7); c.stroke(); }
        const ly = gy + 106 + i * 40;
        c.strokeStyle = 'rgba(243,233,210,0.25)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(X(a.d), gy + 12); c.lineTo(X(a.d), ly - 16); c.stroke();
        T(c, N2(a.d, 2) + ' m', X(a.d), ly, Object.assign({ size: isBest ? 34 : 28, weight: 700, color: isBest ? PAL.gold : '#cfc7b4' }, MONO));
        c.globalAlpha = A0;
      }
    });
    // runner-up
    if (o.next && lt >= o.next.t) {
      const k = ease.outC(sat((lt - o.next.t) / 0.8)), x = X(o.next.d);
      c.globalAlpha = A0 * (k); c.strokeStyle = rgba(PAL.teal, 0.8); c.setLineDash([6, 8]); c.lineWidth = 2;
      c.beginPath(); c.moveTo(x, gy + 6); c.lineTo(x, gy - 300 * k); c.stroke(); c.setLineDash([]);
      T(c, 'NEXT BEST', x - 6, gy - 340, Object.assign({ size: 18, spacing: 4, color: PAL.teal, align: 'right' }, MONO));
      T(c, N2(o.next.d, 2) + ' m', x - 6, gy - 306, Object.assign({ size: 32, weight: 700, color: PAL.teal, align: 'right' }, MONO));
      const b = o.attempts[o.attempts.length - 1], gapCm = Math.round((b.d - o.next.d) * 100);
      const bx = X(b.d);
      c.strokeStyle = rgba(PAL.gold, 0.9); c.lineWidth = 2; c.beginPath(); c.moveTo(x, gy - 40); c.lineTo(bx, gy - 40); c.moveTo(x, gy - 48); c.lineTo(x, gy - 32); c.moveTo(bx, gy - 48); c.lineTo(bx, gy - 32); c.stroke();
      T(c, '+' + gapCm + ' cm', (x + bx) / 2, gy - 66, Object.assign({ size: 24, weight: 700, color: PAL.gold }, MONO));
      c.globalAlpha = A0;
    }
    c.restore();
  };

  // 100 m dot plot on a shared time axis. o = {t0, x0,x1, lo,hi, y2,y1, div2:[..], div1:[..], you, tAvg, tYou, tGhost}
  L.dotplot = function (c, lt, o) {
    const A0 = c.globalAlpha;
    const X = (s) => lerp(o.x0, o.x1, (s - o.lo) / (o.hi - o.lo));
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    c.save();
    // axis
    const ay = o.y1 + 120, pa = sat((lt - o.t0) / 1.0);
    c.globalAlpha = A0 * (pa); c.strokeStyle = 'rgba(243,233,210,0.2)'; c.lineWidth = 2; c.beginPath(); c.moveTo(o.x0 - 20, ay); c.lineTo(o.x1 + 20, ay); c.stroke();
    for (let s = Math.ceil(o.lo * 5) / 5; s <= o.hi + 1e-6; s += 0.2) { c.beginPath(); c.moveTo(X(s), ay - 6); c.lineTo(X(s), ay + 6); c.stroke(); T(c, N2(s, 1), X(s), ay + 32, Object.assign({ size: 20, color: '#8d8676' }, MONO)); }
    T(c, 'SECONDS', o.x0 - 110, ay + 32, Object.assign({ size: 16, spacing: 4, color: '#8d8676', align: 'right' }, MONO));
    T(c, 'DIV 2', o.x0 - 110, o.y2, Object.assign({ size: 30, weight: 700, color: PAL.teal, align: 'right' }, MONO));
    T(c, 'DIV 1', o.x0 - 110, o.y1, Object.assign({ size: 30, weight: 700, color: PAL.blue, align: 'right' }, MONO));
    c.strokeStyle = 'rgba(243,233,210,0.08)'; c.beginPath(); c.moveTo(o.x0 - 20, o.y2); c.lineTo(o.x1 + 20, o.y2); c.moveTo(o.x0 - 20, o.y1); c.lineTo(o.x1 + 20, o.y1); c.stroke();
    c.globalAlpha = A0;
    const row = (arr, y, col, tS, isYou) => arr.forEach((v, i) => {
      const k = ease.outBack(sat((lt - tS - i * 0.16) / 0.5)); if (k <= 0) return;
      const you = isYou && Math.abs(v - o.you) < 1e-6, r = (you ? 15 : 10) * k;
      L.orb(c, X(v), y, r * 3.4, you ? PAL.gold : col, you ? 0.5 : 0.28);
      c.fillStyle = you ? '#ffe3a6' : col; c.beginPath(); c.arc(X(v), y, r, 0, 7); c.fill();
    });
    row(o.div2, o.y2, PAL.teal, o.t0 + 0.4, true);
    row(o.div1, o.y1, PAL.blue, o.t0 + 2.6, false);
    // winners
    const win = (arr, y, col, tt) => { const v = Math.min.apply(null, arr), k = ease.outC(sat((lt - tt) / 0.6)); if (k <= 0) return; c.globalAlpha = A0 * (k); T(c, N2(v, 2), X(v), y - 42, Object.assign({ size: 26, weight: 700, color: col }, MONO)); T(c, 'WINNER', X(v), y - 70, Object.assign({ size: 14, spacing: 4, color: col }, MONO)); c.globalAlpha = A0; };
    win(o.div2, o.y2, PAL.teal, o.tWin); win(o.div1, o.y1, PAL.blue, o.tWin + 1.6);
    // averages
    const av = (arr, y, col, tt) => { const m = avg(arr), k = ease.outC(sat((lt - tt) / 0.7)); if (k <= 0) return m; c.globalAlpha = A0 * (k); c.strokeStyle = rgba(col, 0.9); c.lineWidth = 3; c.beginPath(); c.moveTo(X(m), y - 26); c.lineTo(X(m), y + 26); c.stroke(); T(c, 'AVG ' + N2(m, 2), X(m), y + 58, Object.assign({ size: 20, weight: 700, color: col }, MONO)); c.globalAlpha = A0; return m; };
    av(o.div2, o.y2, PAL.teal, o.tAvg); av(o.div1, o.y1, PAL.blue, o.tAvg + 0.9);
    // you
    if (lt >= o.tYou) {
      const k = ease.outC(sat((lt - o.tYou) / 0.7)); c.globalAlpha = A0 * (k);
      T(c, 'YOU  ' + N2(o.you, 2), X(o.you), o.y2 + 100 - (1 - k) * 12, Object.assign({ size: 26, weight: 700, color: PAL.gold }, MONO));
      c.strokeStyle = rgba(PAL.gold, 0.7); c.lineWidth = 2; c.beginPath(); c.moveTo(X(o.you), o.y2 + 24); c.lineTo(X(o.you), o.y2 + 78); c.stroke(); c.globalAlpha = A0;
    }
    // where you would have finished in division 1
    if (lt >= o.tGhost) {
      const k = ease.outC(sat((lt - o.tGhost) / 1.2)), x = X(o.you), yy = lerp(o.y2 + 24, o.y1 - 22, k);
      c.strokeStyle = rgba(PAL.gold, 0.85); c.lineWidth = 2.5; c.setLineDash([7, 8]); c.beginPath(); c.moveTo(x, o.y2 + 84); c.lineTo(x, lerp(o.y2 + 84, o.y1 - 20, k)); c.stroke(); c.setLineDash([]);
      if (k > 0.85) {
        const g = sat((k - 0.85) / 0.15); c.globalAlpha = A0 * (g); c.strokeStyle = PAL.gold; c.lineWidth = 3.5; c.beginPath(); c.arc(x, o.y1, 18, 0, 7); c.stroke();
        L.orb(c, x, o.y1, 60, PAL.gold, 0.45); T(c, '3RD', x, o.y1 + 58, Object.assign({ size: 30, weight: 700, color: PAL.gold }, MONO)); c.globalAlpha = A0;
      }
    }
    c.restore();
  };

  // relay: four legs left to right, runner dot per leg, one leg highlighted. o = {t0, x0,x1,y, dur, you (1..4), result, place}
  L.relay = function (c, lt, o) {
    const A0 = c.globalAlpha;
    const segW = (o.x1 - o.x0) / 4, pa = sat((lt - o.t0) / 0.8);
    c.save(); c.globalAlpha = A0 * (pa);
    for (let i = 0; i < 4; i++) {
      const xa = o.x0 + i * segW, xb = xa + segW - 14, me = i + 1 === o.you;
      c.strokeStyle = me ? rgba(PAL.gold, 0.9) : 'rgba(243,233,210,0.25)'; c.lineWidth = me ? 6 : 3; c.beginPath(); c.moveTo(xa, o.y); c.lineTo(xb, o.y); c.stroke();
      T(c, (o.names ? o.names[i] : 'LEG ' + (i + 1)), (xa + xb) / 2, o.y + 54, Object.assign({ size: 20, spacing: 4, color: me ? PAL.gold : '#8d8676', weight: me ? 700 : 400 }, MONO));
      if (me) T(c, 'YOU', (xa + xb) / 2, o.y - 62, Object.assign({ size: 34, spacing: 6, color: PAL.gold, weight: 700 }, MONO));
    }
    c.globalAlpha = A0;
    const p = sat((lt - o.t0 - 0.8) / o.dur), leg = Math.min(3, Math.floor(p * 4)), u = p * 4 - leg;
    if (p > 0 && p < 1.001) {
      const xa = o.x0 + leg * segW, x = lerp(xa, xa + segW - 14, ease.inOutS(clampi(u, 0, 1))), me = leg + 1 === o.you;
      L.orb(c, x, o.y, me ? 70 : 46, me ? PAL.gold : '#f3e9d2', 0.7);
      c.fillStyle = '#fff'; c.beginPath(); c.arc(x, o.y, me ? 9 : 7, 0, 7); c.fill();
      for (let k = 1; k < 7; k++) { c.globalAlpha = A0 * (0.5 * (1 - k / 7)); c.beginPath(); c.arc(x - k * 14, o.y, 5 - k * 0.5, 0, 7); c.fill(); }
      c.globalAlpha = A0;
    }
    if (lt >= o.t0 + 0.8 + o.dur) {
      const k = ease.outBack(sat((lt - o.t0 - 0.8 - o.dur) / 0.7));
      T(c, o.place, o.x0 + (o.x1 - o.x0) / 2 - 160, o.y - 210, { size: 110 * k, style: 'italic', weight: 500, color: '#fff1cc' });
      T(c, o.result, o.x0 + (o.x1 - o.x0) / 2 + 150, o.y - 200, Object.assign({ size: 62 * k, weight: 700, color: PAL.gold }, MONO));
    }
    c.restore();
  };

  // ---------- priorities orbit ----------
  // o: {cx,cy,rx,ry, nodes:[{label,sub,t,col,ang}], centre, dropped:[{text,t,x,y}]}
  L.orbit = function (c, lt, o) {
    const A0 = c.globalAlpha;
    c.save();
    const cp = ease.outBack(sat((lt - (o.t0 || 0.6)) / 0.9));
    o.nodes.forEach((n, i) => {
      const p = ease.outC(sat((lt - n.t) / 0.8)); if (p <= 0) return;
      const fx = Math.sin(lt * 0.5 + i * 1.9) * 7, fy = Math.cos(lt * 0.6 + i) * 6;
      const x = o.cx + Math.cos(n.ang) * o.rx + fx, y = o.cy + Math.sin(n.ang) * o.ry + fy;
      const ex = lerp(o.cx, x, p), ey = lerp(o.cy, y, p);
      const g = c.createLinearGradient(o.cx, o.cy, ex, ey); g.addColorStop(0, rgba(PAL.gold, 0.5)); g.addColorStop(1, rgba(n.col, 0.55));
      c.strokeStyle = g; c.lineWidth = n.big ? 3 : 2; c.beginPath(); c.moveTo(o.cx, o.cy); c.lineTo(ex, ey); c.stroke();
      const k = ease.outBack(sat((lt - n.t - 0.2) / 0.7)), r = (n.big ? 24 : 17) * k;
      L.orb(c, x, y, r * 4.2, n.col, n.big ? 0.5 : 0.36);
      c.fillStyle = '#0d0d0d'; c.beginPath(); c.arc(x, y, r + 3, 0, 7); c.fill();
      c.strokeStyle = n.col; c.lineWidth = 3.5; c.beginPath(); c.arc(x, y, r, 0, 7); c.stroke();
      c.fillStyle = n.col; c.beginPath(); c.arc(x, y, r * 0.42, 0, 7); c.fill();
      const above = Math.sin(n.ang) < -0.1, la = sat((lt - n.t - 0.3) / 0.6);
      c.globalAlpha = A0 * (la);
      const subs = L.wrapText(c, n.sub, 380, Object.assign({ size: 19, spacing: 2 }, MONO));
      const blockH = 60 + subs.length * 26;
      const ty = above ? y - r - 30 - blockH + 30 : y + r + 40;
      T(c, n.label, x, ty, { size: n.big ? 58 : 50, style: 'italic', weight: 400, color: n.col === PAL.gold ? '#fff1cc' : '#f3e9d2' });
      subs.forEach((s, j) => T(c, s, x, ty + 46 + j * 26, Object.assign({ size: 19, spacing: 2, color: '#a89f8c' }, MONO)));
      c.globalAlpha = A0;
    });
    if (cp > 0) {
      const pul = 1 + 0.05 * Math.sin(lt * 2.4);
      L.orb(c, o.cx, o.cy, 130 * cp * pul, PAL.gold, 0.55);
      c.fillStyle = '#fff1cc'; c.beginPath(); c.arc(o.cx, o.cy, 12 * cp, 0, 7); c.fill();
      c.globalAlpha = A0 * (cp); T(c, o.centre, o.cx, o.cy + 46, Object.assign({ size: 18, spacing: 8, color: PAL.gold }, MONO)); c.globalAlpha = A0;
    }
    (o.dropped || []).forEach((d) => {
      const age = lt - d.t; if (age < 0) return;
      const a = ease.outC(sat(age / 0.6)) * (1 - sat((age - 5.5) / 2.2));
      if (a <= 0.01) return;
      const drift = ease.inQ(sat((age - 2.6) / 5)) * 60;
      c.globalAlpha = A0 * (a * 0.8);
      const st = { size: 54, style: 'italic', weight: 300, color: '#8d8676' };
      T(c, d.text, d.x, d.y - drift, st);
      const w = U.measure(c, d.text, st), s = ease.outC(sat((age - 0.9) / 0.7));
      c.strokeStyle = rgba('#e5484d', 0.85); c.lineWidth = 3; c.beginPath(); c.moveTo(d.x - w / 2 - 6, d.y - drift + 4); c.lineTo(d.x - w / 2 - 6 + (w + 12) * s, d.y - drift + 4); c.stroke();
      c.globalAlpha = A0;
    });
    c.restore();
  };

  // ---------- breath orb ----------
  // o: {cx,cy, r0, calmT (time breathing turns steady), fadeT, fadeDur, hug:{t0,t1,n}, dim}
  L.breath = function (c, lt, o) {
    const A0 = c.globalAlpha;
    const calm = ease.inOutS(sat((lt - o.calmT) / 5));
    const rate = lerp(0.42, 0.22, calm);
    const irr = (1 - calm) * (0.7 * Math.sin(lt * 1.9) + 0.4 * Math.sin(lt * 3.3 + 1));
    const ph = lt * rate + irr * 0.25, k = 0.5 + 0.5 * Math.sin(ph * 6.2832);
    const fade = 1 - ease.inOutS(sat((lt - o.fadeT) / o.fadeDur));
    let boost = 0;
    const h = o.hug;
    if (h) boost = 0.5 * ease.inOutS(sat((lt - h.t0) / (h.t1 - h.t0)));
    const r = o.r0 * (0.86 + 0.28 * k) * (0.35 + 0.65 * fade + boost * 0.4);
    c.save();
    c.globalAlpha = A0 * (0.25 + 0.75 * fade * (0.6 + 0.4 * k));
    L.orb(c, o.cx, o.cy, r * 3.4, '#f2c877', 0.55 + boost * 0.4);
    c.fillStyle = '#fff1cc'; c.beginPath(); c.arc(o.cx, o.cy, r * 0.16, 0, 7); c.fill();
    c.globalAlpha = A0;
    // rings on each exhale
    for (let j = 0; j < 3; j++) {
      const q = (((ph * 1 - j * 0.55) % 1) + 1) % 1, a = (1 - q) * 0.25 * fade;
      c.strokeStyle = rgba('#f2c877', a); c.lineWidth = 2; c.beginPath(); c.arc(o.cx, o.cy, r * (0.9 + q * 2.2), 0, 7); c.stroke();
    }
    if (h) {
      const R = rng(11);
      for (let i = 0; i < h.n; i++) {
        const ang = (i / h.n) * 6.2832 + R() * 0.4, delay = (i / h.n) * (h.t1 - h.t0 - 3);
        const p = ease.inOutS(sat((lt - h.t0 - delay) / 3.0)), rr = lerp(640 + R() * 120, 60 + (i % 3) * 22, p);
        const a = sat((lt - h.t0 - delay) / 0.8) * (1 - sat((lt - h.t1 - 1.5) / 2.5)); if (a <= 0) continue;
        const x = o.cx + Math.cos(ang) * rr * 1.5, y = o.cy + Math.sin(ang) * rr * 0.62;
        c.globalAlpha = A0 * (a); L.orb(c, x, y, 26, i % 2 ? '#e6b25e' : '#f3e9d2', 0.5); c.fillStyle = '#fff1cc'; c.beginPath(); c.arc(x, y, 4.2, 0, 7); c.fill();
      }
      c.globalAlpha = A0;
    }
    c.restore();
  };

  // ---------- quote card ----------
  // o: {x,y,w,h, rot, t0, t1, title, quote, cps}
  L.quoteCard = function (c, lt, o) {
    const A0 = c.globalAlpha;
    const fi = ease.outC(sat((lt - o.t0) / 0.8)), fo = 1 - sat((lt - o.t1) / 0.9), a = fi * fo; if (a <= 0.003) return;
    const st = { size: 44, style: 'italic', weight: 300 };
    c.save(); c.globalAlpha = A0 * (a); c.translate(o.x, o.y + (1 - fi) * 30); c.rotate((o.rot || 0) * Math.PI / 180);
    c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 30; c.shadowOffsetY = 12;
    c.fillStyle = '#14130f'; U.roundRect(c, -o.w / 2, -o.h / 2, o.w, o.h, 10); c.fill(); c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0;
    c.strokeStyle = 'rgba(230,178,94,0.35)'; c.lineWidth = 2; U.roundRect(c, -o.w / 2, -o.h / 2, o.w, o.h, 10); c.stroke();
    c.fillStyle = PAL.gold; c.fillRect(-o.w / 2 + 34, -o.h / 2 + 34, 38, 4);
    T(c, o.title, -o.w / 2 + 34, -o.h / 2 + 68, Object.assign({ size: 20, spacing: 2, color: '#8d8676', align: 'left' }, MONO));
    const lines = L.wrapText(c, '“' + o.quote + '”', o.w - 90, st);
    const cnt = Math.floor(Math.max(0, lt - o.t0 - 0.5) * (o.cps || 34));
    let left = cnt, y = -o.h / 2 + 130;
    lines.forEach((ln, i) => {
      const shown = ln.slice(0, Math.max(0, left)); left -= ln.length + 1;
      if (shown) T(c, shown, -o.w / 2 + 34, y + i * 56, Object.assign({}, st, { align: 'left', color: '#f3e9d2' }));
    });
    c.restore();
  };

  // ---------- hospital: a road to a labelled destination, then the room seen from above ----------
  // o: {label, roadEnd, tFig, tChild, tHold, tHug0, tHug1, tQuiet, tOut, outDur}
  L.hospital = function (c, lt, o) {
    const A0 = c.globalAlpha, cx = W / 2, cy = 470, N = 12;
    // road
    const ra = sat(lt / 1.2) * (1 - sat((lt - (o.roadEnd - 1.4)) / 1.4));
    if (ra > 0) {
      c.save(); c.globalAlpha = A0 * ra;
      const vy = 430;
      L.orb(c, cx, vy, 120 + 260 * sat(lt / o.roadEnd), '#f2c877', 0.35);
      c.strokeStyle = 'rgba(243,233,210,0.16)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(cx, vy); c.lineTo(cx - 760, 1000); c.moveTo(cx, vy); c.lineTo(cx + 760, 1000); c.stroke();
      for (let k = 0; k < 14; k++) {
        const s = (((k / 14) + lt * 0.16) % 1), e = Math.pow(s, 2.2), y = vy + e * 560;
        c.globalAlpha = A0 * ra * Math.min(1, s * 3) * 0.75; c.fillStyle = '#f3e9d2';
        c.fillRect(cx - (3 + e * 9), y, 6 + e * 18, 6 + e * 90);
      }
      c.globalAlpha = A0 * ra * sat((lt - 1.0) / 1.4) * 0.8;
      T(c, o.label || '', cx, vy - 46, Object.assign({ size: 22, spacing: 10, color: PAL.gold }, MONO));
      c.restore();
    }
    // room
    const rk = ease.inOutS(sat((lt - (o.roadEnd - 1.6)) / 2.4)) * (1 - sat((lt - o.tOut) / o.outDur));
    if (rk <= 0.003) return;
    c.save(); c.globalAlpha = A0 * rk;
    const quiet = ease.inOutS(sat((lt - o.tQuiet) / 5));
    const bw = 300, bh = 150;
    L.orb(c, cx, cy, 360, '#ffbe6e', 0.28 * (1 - 0.65 * quiet));
    c.fillStyle = 'rgba(255,190,110,0.07)'; U.roundRect(c, cx - bw / 2, cy - bh / 2, bw, bh, 22); c.fill();
    c.strokeStyle = 'rgba(243,233,210,0.4)'; c.lineWidth = 2.5; U.roundRect(c, cx - bw / 2, cy - bh / 2, bw, bh, 22); c.stroke();
    c.strokeStyle = 'rgba(243,233,210,0.25)'; U.roundRect(c, cx - bw / 2 + 14, cy - bh / 2 + 14, 70, bh - 28, 12); c.stroke();
    // monitor trace above the bed
    if (lt > o.tFig - 1) {
      const ma = sat((lt - (o.tFig - 1)) / 1.5), irr = 1 - quiet;
      c.globalAlpha = A0 * rk * ma * 0.8; c.strokeStyle = rgba('#f2c877', 0.9); c.lineWidth = 2.5; c.beginPath();
      for (let i = 0; i <= 180; i++) {
        const x = cx - 240 + i * 2.67, tt = lt - (cx + 240 - x) / 200, per = 1.5, k = Math.floor(tt / per);
        const u = tt - k * per - irr * 0.32 * Math.sin(k * 7.3), a = quiet > 0.5 ? 0.45 : 1;
        const y = 335 - a * 40 * (Math.exp(-Math.pow((u - 0.35) / 0.04, 2)) - 0.3 * Math.exp(-Math.pow((u - 0.52) / 0.07, 2)));
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.stroke();
      c.globalAlpha = A0 * rk;
    }
    // people around the bed
    const R = rng(33), fig = [];
    for (let i = 0; i < N; i++) {
      const ang = -Math.PI / 2 + (i + 0.5) * (Math.PI * 2 / N), rx = 500 + (i % 3) * 40, ry = 230 + (i % 2) * 20;
      fig.push({ x: cx + Math.cos(ang) * rx, y: cy + Math.sin(ang) * ry * 1.1, ph: R() * 6, t: o.tFig + i * 0.32 });
    }
    // hug tour order: clockwise from the bed's left side
    const order = fig.map((f, i) => i).sort((a, b) => Math.atan2(fig[a].y - cy, fig[a].x - cx) - Math.atan2(fig[b].y - cy, fig[b].x - cx));
    const visit = new Array(N); order.forEach((fi, k) => { visit[fi] = o.tHug0 + (k + 0.5) * (o.tHug1 - o.tHug0) / N; });
    fig.forEach((f, i) => {
      const p = ease.outC(sat((lt - f.t) / 0.9)); if (p <= 0) return;
      const vd = lt > visit[i], vk = vd ? ease.outC(sat((lt - visit[i]) / 1.2)) : 0;
      const tr = Math.sin(lt * 5 + f.ph) * 1.6 * (1 - vk * 0.6), fx = f.x + tr, fy = f.y + Math.cos(lt * 4.3 + f.ph) * 1.2;
      c.globalAlpha = A0 * rk * p * (1 - 0.35 * quiet);
      L.orb(c, fx, fy, 62 + vk * 34, vd ? '#ffd28a' : '#c9a15a', 0.45 + vk * 0.3);
      c.fillStyle = vd ? '#fff1cc' : '#e6c98a'; c.beginPath(); c.arc(fx, fy, 15, 0, 7); c.fill();
      // tears drift down, slower once held
      for (let k = 0; k < 2; k++) {
        const per = 1.5 + k * 0.6 + vk * 1.4, q = (((lt + f.ph * 3 + k * 0.7) % per) + per) % per / per;
        c.globalAlpha = A0 * rk * p * (1 - q) * 0.75 * (1 - 0.4 * vk); c.fillStyle = '#b6d4ff';
        c.beginPath(); c.arc(fx + (k ? 9 : -9), fy + 16 + q * 46, 2.6, 0, 7); c.fill();
      }
      const age = lt - visit[i];
      if (age > 0 && age < 1.5) { c.globalAlpha = A0 * rk * (1 - age / 1.5); c.strokeStyle = rgba('#ffd28a', 0.9); c.lineWidth = 2.5; c.beginPath(); c.arc(fx, fy, 24 + age * 60, 0, 7); c.stroke(); }
    });
    // the child
    if (lt > o.tChild) {
      const bedX = cx - 210, bedY = cy;
      let px, py;
      const entry = ease.inOutS(sat((lt - o.tChild) / (o.tHold - o.tChild)));
      px = lerp(cx - 260, bedX, entry); py = lerp(880, bedY, entry);
      if (lt > o.tHug0) {
        let pos = [bedX, bedY]; const t0 = o.tHug0;
        for (let k = 0; k < N; k++) {
          const fi = order[k], f = fig[fi], target = [lerp(f.x, cx, 0.16), lerp(f.y, cy, 0.16)];
          const arr = visit[fi] - 0.55;
          if (lt >= arr) pos = [lerp(pos[0], target[0], ease.inOutS(sat((lt - arr) / 0.55))), lerp(pos[1], target[1], ease.inOutS(sat((lt - arr) / 0.55)))];
          else break;
        }
        px = pos[0]; py = pos[1];
        const back = ease.inOutS(sat((lt - o.tHug1) / 2.0)); px = lerp(px, bedX, back); py = lerp(py, bedY, back);
      }
      c.globalAlpha = A0 * rk * sat((lt - o.tChild) / 1.0) * (1 - 0.5 * quiet);
      L.orb(c, px, py, 70, '#a9c8ff', 0.7); c.fillStyle = '#eaf2ff'; c.beginPath(); c.arc(px, py, 9, 0, 7); c.fill();
      if (lt > o.tHold && lt < o.tHug0) {
        const k = ease.outC(sat((lt - o.tHold) / 1.2)); c.globalAlpha = A0 * rk * k;
        c.strokeStyle = rgba('#f2c877', 0.9); c.lineWidth = 3; c.beginPath(); c.moveTo(bedX + 8, bedY); c.lineTo(bedX + 70, bedY); c.stroke();
        for (let r = 0; r < 3; r++) { const q = (((lt - o.tHold - r * 1.2) % 3.6) + 3.6) % 3.6 / 3.6; c.globalAlpha = A0 * rk * (1 - q) * 0.5; c.strokeStyle = rgba('#f2c877', 1); c.lineWidth = 2; c.beginPath(); c.arc(bedX + 40, bedY, 20 + q * 120, 0, 7); c.stroke(); }
      }
    }
    // clock: the hour it took
    if (lt > o.tHug0 - 0.6 && lt < o.tHug1 + 2.5) {
      const ka = sat((lt - (o.tHug0 - 0.6)) / 0.8) * (1 - sat((lt - o.tHug1 - 1.0) / 1.5)), pr = sat((lt - o.tHug0) / (o.tHug1 - o.tHug0)), sec = Math.round(pr * 3600);
      const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
      c.globalAlpha = A0 * rk * ka;
      T(c, 'THE HOUR IN THE ROOM', W - 92, 88, Object.assign({ size: 18, spacing: 5, color: '#a89f8c', align: 'right' }, MONO));
      T(c, hh + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0'), W - 92, 132, Object.assign({ size: 46, weight: 700, color: '#f2c877', align: 'right' }, MONO));
    }
    c.restore();
  };
})();
