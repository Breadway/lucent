// Components for the personal film: maker cards, dance floor, floating memories, binary stars, timeline, house.
(function () {
  const { W, H, PAL, clamp, sat, lerp, ease, T, rgba, rng, measure } = U;
  const L = window.L;

  // ---------- procedural icons (drawn around 0,0, about 240x180) ----------
  const ICON = {
    print(c, lt) { // shield being printed layer by layer
      const prog = (lt * 0.3) % 1;
      c.beginPath(); c.moveTo(-70, -80); c.lineTo(70, -80); c.lineTo(70, 10); c.quadraticCurveTo(70, 70, 0, 95); c.quadraticCurveTo(-70, 70, -70, 10); c.closePath();
      c.strokeStyle = PAL.gold; c.lineWidth = 4; c.stroke();
      c.save(); c.clip();
      for (let i = 0; i < 24; i++) { const yy = 95 - i * 7.6; if ((95 - yy) / 175 > prog) break; c.strokeStyle = rgba(PAL.gold, 0.5); c.lineWidth = 2.5; c.beginPath(); c.moveTo(-80, yy); c.lineTo(80, yy); c.stroke(); }
      c.restore();
      const ny = 95 - prog * 175; c.fillStyle = '#fff'; c.beginPath(); c.arc(-70 + 140 * ((lt * 1.4) % 1), ny, 5, 0, 7); c.fill();
      L.orb(c, -70 + 140 * ((lt * 1.4) % 1), ny, 50, PAL.gold, 0.6);
    },
    keys(c, lt) { // split keyboard
      const r = rng(7);
      for (const side of [-1, 1]) for (let row = 0; row < 3; row++) for (let k = 0; k < 5; k++) {
        const x = side * (26 + k * 26) + (side > 0 ? 0 : -24), y = -46 + row * 32 + (k === 4 ? 8 : 0);
        const lit = Math.sin(lt * 3 + row * 1.7 + k * 0.9 + side) > 0.82;
        c.fillStyle = lit ? PAL.gold : 'rgba(243,233,210,0.16)'; U.roundRect(c, x, y, 22, 24, 5); c.fill();
      }
      c.strokeStyle = 'rgba(243,233,210,0.25)'; c.lineWidth = 2; c.setLineDash([4, 6]); c.beginPath(); c.moveTo(0, -60); c.lineTo(0, 70); c.stroke(); c.setLineDash([]);
    },
    chips(c, lt) { // two ESP32s playing laser tag
      for (const s of [-1, 1]) {
        c.save(); c.translate(s * 92, 0);
        c.fillStyle = 'rgba(243,233,210,0.10)'; U.roundRect(c, -34, -34, 68, 68, 8); c.fill(); c.strokeStyle = PAL.teal; c.lineWidth = 3; U.roundRect(c, -34, -34, 68, 68, 8); c.stroke();
        for (let i = 0; i < 5; i++) { c.fillStyle = PAL.teal; c.fillRect(-42, -26 + i * 13, 8, 4); c.fillRect(34, -26 + i * 13, 8, 4); }
        c.fillStyle = PAL.teal; c.beginPath(); c.arc(0, 0, 8 + 2 * Math.sin(lt * 4 + s), 0, 7); c.fill(); c.restore();
      }
      for (let k = 0; k < 3; k++) { const p = ((lt * 0.7 + k / 3) % 1); c.strokeStyle = rgba(PAL.teal, (1 - p) * 0.8); c.lineWidth = 3; c.beginPath(); c.arc(-92, 0, 40 + p * 110, -0.5, 0.5); c.stroke(); }
      const bx = lerp(-60, 60, (lt * 0.9) % 1); c.fillStyle = '#ff6a6a'; c.fillRect(bx - 14, -2, 28, 4); L.orb(c, bx, 0, 30, '#ff6a6a', 0.6);
    },
    adder(c, lt) { // logic gates with a signal running through
      c.strokeStyle = PAL.blue; c.lineWidth = 3.5;
      const gate = (x, y, xor) => { c.beginPath(); c.moveTo(x, y - 26); c.quadraticCurveTo(x + 54, y - 22, x + 58, y); c.quadraticCurveTo(x + 54, y + 22, x, y + 26); if (xor) c.quadraticCurveTo(x + 16, y, x, y - 26); else { c.lineTo(x, y - 26); } c.stroke(); if (xor) { c.beginPath(); c.moveTo(x - 10, y - 26); c.quadraticCurveTo(x + 6, y, x - 10, y + 26); c.stroke(); } };
      gate(-30, -48, true); gate(-30, 48, false); c.beginPath(); c.moveTo(-110, -60); c.lineTo(-30, -60); c.moveTo(-110, -36); c.lineTo(-30, -36); c.moveTo(-110, 36); c.lineTo(-30, 36); c.moveTo(-110, 60); c.lineTo(-30, 60); c.moveTo(28, -48); c.lineTo(110, -48); c.moveTo(28, 48); c.lineTo(110, 48); c.stroke();
      const t = (lt * 0.8) % 1; for (const [y0, y1] of [[-60, -48], [36, 48], [-36, -48], [60, 48]]) { const x = lerp(-110, 110, t); const y = t < 0.5 ? y0 : y1; L.orb(c, x, y, 24, PAL.blue, 0.8); }
      T(c, '1 + 1 = 10', 0, 100, { font: 'JetBrains Mono', size: 20, weight: 700, color: PAL.blue });
    },
    cards(c, lt) { // fan of cards
      [-1, 0, 1].forEach((k, i) => {
        c.save(); c.translate(k * 60, 20 - (k === 0 ? 14 : 0) + Math.sin(lt * 1.4 + i) * 4); c.rotate(k * 0.3);
        c.fillStyle = '#12100a'; U.roundRect(c, -46, -70, 92, 132, 10); c.fill(); c.strokeStyle = PAL.violet; c.lineWidth = 3; U.roundRect(c, -46, -70, 92, 132, 10); c.stroke();
        c.fillStyle = PAL.violet; c.beginPath(); for (let a = 0; a < 8; a++) { const rr = a % 2 ? 9 : 24; c.lineTo(Math.cos(a * Math.PI / 4 - Math.PI / 2) * rr, Math.sin(a * Math.PI / 4 - Math.PI / 2) * rr - 12); } c.closePath(); c.fill();
        c.restore();
      });
    },
    bug(c, lt) { // exterminator target
      c.fillStyle = PAL.green; c.beginPath(); c.ellipse(0, 6, 32, 42, 0, 0, 7); c.fill(); c.fillStyle = '#0c0c0c'; c.beginPath(); c.arc(-12, -24, 6, 0, 7); c.arc(12, -24, 6, 0, 7); c.fill();
      c.strokeStyle = PAL.green; c.lineWidth = 4; for (let s = -1; s <= 1; s += 2) for (let i = 0; i < 3; i++) { const w = Math.sin(lt * 9 + i * 1.3) * 6; c.beginPath(); c.moveTo(s * 28, -8 + i * 22); c.lineTo(s * (60 + w), -14 + i * 26); c.stroke(); }
      const ch = 1 + 0.08 * Math.sin(lt * 6); c.strokeStyle = PAL.red; c.lineWidth = 3; c.beginPath(); c.arc(0, 6, 62 * ch, 0, 7); c.moveTo(-84, 6); c.lineTo(-40, 6); c.moveTo(40, 6); c.lineTo(84, 6); c.moveTo(0, -76); c.lineTo(0, -32); c.moveTo(0, 44); c.lineTo(0, 88); c.stroke();
    },
    planet(c, lt) { // asteroid belt
      const g = c.createRadialGradient(-14, -14, 4, 0, 0, 44); g.addColorStop(0, '#ffd9a0'); g.addColorStop(1, '#8a4a20'); c.fillStyle = g; c.beginPath(); c.arc(0, 0, 40, 0, 7); c.fill();
      const r = rng(3); for (let i = 0; i < 70; i++) { const a = r() * 6.28 + lt * (0.25 + r() * 0.3), rr = 78 + r() * 34; const x = Math.cos(a) * rr, y = Math.sin(a) * rr * 0.32; if (Math.sin(a) < 0 && Math.abs(x) < 42) continue; c.fillStyle = rgba('#d8c8a8', 0.4 + r() * 0.5); c.fillRect(x, y, 2 + r() * 3, 2 + r() * 3); }
    },
    loaf(c, lt) { // bread, for BOS
      c.beginPath(); c.moveTo(-90, 40); c.quadraticCurveTo(-100, -20, -50, -46); c.quadraticCurveTo(0, -78, 50, -46); c.quadraticCurveTo(100, -20, 90, 40); c.quadraticCurveTo(0, 58, -90, 40); c.closePath();
      const g = c.createLinearGradient(0, -70, 0, 50); g.addColorStop(0, '#e6b25e'); g.addColorStop(1, '#9a5a20'); c.fillStyle = g; c.fill();
      c.strokeStyle = 'rgba(60,30,8,0.6)'; c.lineWidth = 4; for (let i = -1; i <= 1; i++) { c.beginPath(); c.moveTo(i * 34 - 12, -34); c.lineTo(i * 34 + 10, -6); c.stroke(); }
      L.orb(c, 0, -10, 130, PAL.gold, 0.25 + 0.1 * Math.sin(lt * 2));
    },
  };

  L.makers = function (c, lt, o) {
    const cw = 380, ch = 300, gx = 40, gy = 36, cols = 4;
    const x0 = (W - (cols * cw + (cols - 1) * gx)) / 2, y0 = o.y0 || 200;
    c.save();
    o.items.forEach((it, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const cx = x0 + col * (cw + gx) + cw / 2, cy = y0 + row * (ch + gy) + ch / 2;
      const p = sat((lt - it.t) / 0.8); if (p <= 0) return;
      const e = ease.outBack(p), sx = Math.max(0.001, e);
      c.save(); c.translate(cx, cy); c.scale(sx, 1); c.globalAlpha = sat(p * 2);
      c.fillStyle = 'rgba(255,255,255,0.035)'; U.roundRect(c, -cw / 2, -ch / 2, cw, ch, 20); c.fill();
      c.strokeStyle = rgba(it.col || PAL.gold, 0.55); c.lineWidth = 2; U.roundRect(c, -cw / 2, -ch / 2, cw, ch, 20); c.stroke();
      c.save(); c.translate(0, -34); c.scale(0.95, 0.95); ICON[it.icon](c, lt - it.t); c.restore();
      T(c, it.name, 0, 88, { size: 44, style: 'italic', weight: 400, color: '#f6ecd6' });
      T(c, it.sub.toUpperCase(), 0, 126, { font: 'JetBrains Mono', size: 17, spacing: 2, color: '#a89f8c' });
      c.restore();
      if (p < 1) L.orb(c, cx, cy, 240 * (1 - p), it.col || PAL.gold, 0.3 * (1 - p));
    });
    c.restore();
  };

  // ---------- dance floor ----------
  L.dancefloor = function (c, lt, o) {
    const cx = W / 2, cy = 500, tPull = o.tPull, tJoin = o.tJoin, bpm = o.bpm || 100;
    const bph = (lt * bpm / 60) % 1, pulse = Math.pow(1 - bph, 3), beatOn = sat((lt - tPull) / 1.5), open = lt > tJoin ? 1 : 0;
    if (open) G.flash = Math.max(G.flash, 0.035 * Math.pow(1 - bph, 5));
    c.save();
    // floor rings + light
    L.orb(c, cx, cy + 60, 620, '#ffb35a', 0.10);
    for (let k = 0; k < 4; k++) { c.strokeStyle = `rgba(243,233,210,${0.10 - k * 0.02})`; c.lineWidth = 2; c.beginPath(); c.ellipse(cx, cy + 60, 240 + k * 110, 80 + k * 38, 0, 0, 7); c.stroke(); }
    // bokeh lights above
    const r = rng(12);
    for (let i = 0; i < 26; i++) {
      const bx = r() * W, by = 60 + r() * 220, br = 30 + r() * 70, ph = r() * 6.28, col = [PAL.gold, '#ff9a6a', '#ffd48a', PAL.violet][Math.floor(r() * 4)];
      L.orb(c, bx + Math.sin(lt * 0.3 + ph) * 30, by, br, col, 0.10 + 0.08 * Math.sin(lt * 1.4 + ph));
    }
    // dancers
    const joined = lt > tJoin;
    const N = 18, rr = rng(5);
    for (let i = 0; i < N; i++) {
      const ring = i % 3, a0 = (i / N) * 6.283 + rr() * 0.4, sp = (ring % 2 ? -1 : 1) * (0.25 + 0.06 * ring);
      const a = a0 + lt * sp, ex = 200 + ring * 105, ey = 62 + ring * 36;
      const x = cx + Math.cos(a) * ex * (1 + 0.02 * pulse * beatOn), y = cy + 60 + Math.sin(a) * ey - Math.abs(Math.sin(Math.PI * lt * bpm / 60 + i * 0.4)) * 12 * beatOn;
      L.orb(c, x, y, 34 + 14 * pulse * beatOn, PAL.gold, 0.35 + 0.25 * pulse * beatOn); c.fillStyle = '#ffe3a6'; c.beginPath(); c.arc(x, y, 6.5 + 1.5 * pulse * beatOn, 0, 7); c.fill();
    }
    // you (start at the edge, sitting out)
    const sit = { x: 250, y: 780 };
    const floorPos = { x: cx + 40, y: cy + 60 };
    const sisterStart = { x: cx - 300, y: cy + 60 + 62 };
    const pull = ease.inOutC(sat((lt - tPull) / 1.6));
    const join = ease.inOutC(sat((lt - tJoin) / 2.0));
    // sister walks over to you at tPull, holds hands, then both go to the floor
    const sisX = lerp(lerp(sisterStart.x, sit.x + 60, pull), floorPos.x - 50, join), sisY = lerp(lerp(sisterStart.y, sit.y - 8, pull), floorPos.y + 6, join);
    const youX = lerp(sit.x, floorPos.x + 40, join), youY = lerp(sit.y + Math.sin(lt * 1.2) * 3, floorPos.y + 4, join);
    // hands
    if (pull > 0.85 && join < 1) { c.strokeStyle = rgba('#fff1cc', 0.9); c.lineWidth = 4; c.beginPath(); c.moveTo(sisX, sisY); c.lineTo(youX, youY); c.stroke(); }
    // sister
    L.orb(c, sisX, sisY, 90, PAL.teal, 0.65); c.fillStyle = '#c8fff5'; c.beginPath(); c.arc(sisX, sisY, 14, 0, 7); c.fill();
    if (lt > tPull - 1) T(c, 'Tayla', sisX, sisY - 34, { font: 'JetBrains Mono', size: 26, weight: 700, spacing: 3, color: PAL.teal, alpha: sat((lt - tPull + 1) / 0.6) });
    // you
    L.orb(c, youX, youY, 130 + 40 * pulse * beatOn * open, '#fff1cc', 0.8); c.fillStyle = '#fff'; c.beginPath(); c.arc(youX, youY, 17, 0, 7); c.fill();
    T(c, 'you', youX, youY + 48, { size: 40, style: 'italic', weight: 300, color: '#fff1cc' });
    // burst when you join
    const tb = lt - (tJoin + 2.0);
    if (tb > 0 && tb < 2.2) { const k = tb / 2.2; c.strokeStyle = rgba('#fff1cc', (1 - k) * 0.9); c.lineWidth = 6 * (1 - k) + 1; c.beginPath(); c.ellipse(floorPos.x + 40, floorPos.y, 60 + k * 620, 30 + k * 240, 0, 0, 7); c.stroke(); G.flash = Math.max(G.flash, 0.05 * (1 - k)); }
    c.restore();
  };

  // ---------- floating small things ----------
  L.floaters = function (c, lt, o) {
    c.save();
    o.items.forEach((it, i) => {
      const age = lt - it.t; if (age < 0) return;
      const p = ease.outC(sat(age / 1.6));
      const size = it.size || 46;
      const x = it.x + Math.sin(lt * 0.4 + i * 1.7) * 10, y = it.y - p * 18 - Math.min(age, 40) * 1.5 + Math.cos(lt * 0.35 + i) * 6;
      const a = p * (0.42 + 0.58 * (1 - sat((age - 5.5) / 5)));
      const wPx = measure(c, it.text, { size, style: 'italic', weight: 300 });
      L.orb(c, x, y, wPx * 0.5 + 60, it.col || PAL.gold, 0.16 * a);
      c.globalAlpha = a; T(c, it.text, x, y, { size, style: 'italic', weight: 300, color: it.col ? '#f6ecd6' : '#f6ecd6', spacing: (1 - p) * 4 }); c.globalAlpha = 1;
      // spark burst at appear
      if (age < 1.6) { const r = rng(90 + i); for (let k = 0; k < 16; k++) { const ang = r() * 6.283, d = ease.outC(age / 1.6) * (40 + r() * 90); c.fillStyle = rgba(it.col || PAL.gold, (1 - age / 1.6) * 0.8); c.fillRect(x + Math.cos(ang) * d, y + Math.sin(ang) * d * 0.6, 2.5, 2.5); } }
    });
    c.restore();
  };

  // ---------- two stars: apart, then together ----------
  L.binary = function (c, lt, o) {
    const cx = W / 2, cy = o.cy || 470, tR = o.tReturn, tJ = o.tJoin;
    const ap = ease.inOutC(sat((lt - tR) / (tJ - tR)));
    const dist = lerp(560 + 24 * Math.sin(lt * 0.5), 120, ap);
    const joinedK = sat((lt - tJ) / 1.5);
    const th = (lt - tJ) * 0.95;
    const posA = joinedK > 0 ? [cx - Math.cos(th) * dist * 1, cy - Math.sin(th) * dist * 0.55] : [cx - dist, cy + Math.sin(lt * 0.9) * 22];
    const posB = joinedK > 0 ? [cx + Math.cos(th) * dist, cy + Math.sin(th) * dist * 0.55] : [cx + dist, cy + Math.cos(lt * 0.8) * 22];
    // if just after join, blend from separated wobble to orbit
    const A = joinedK > 0 && joinedK < 1 ? [lerp(cx - dist, posA[0], joinedK), lerp(cy, posA[1], joinedK)] : posA;
    const B = joinedK > 0 && joinedK < 1 ? [lerp(cx + dist, posB[0], joinedK), lerp(cy, posB[1], joinedK)] : posB;
    c.save();
    // faint rings around each while apart
    if (lt < tJ) for (const P of [A, B]) { c.strokeStyle = 'rgba(243,233,210,0.08)'; c.lineWidth = 1.5; for (let k = 1; k <= 3; k++) { c.beginPath(); c.arc(P[0], P[1], 40 + k * 46, 0, 7); c.stroke(); } }
    // messages that try to cross
    const per = 3.2;
    if (lt > 1) for (let k = 0; k < 1; k++) {
      const ph = ((lt - 1) % per) / per; const reach = lt < tR ? 0.42 : lt < tJ ? lerp(0.42, 1, ap) : 1;
      const f = ph < 0.7 ? ph / 0.7 : 1; const q = f * reach;
      if (lt < tJ) {
        const px = lerp(A[0], B[0], q), py = lerp(A[1], B[1], q);
        c.strokeStyle = rgba('#fff1cc', 0.25 * (1 - (reach < 1 ? sat((f - 0.85) / 0.15) : 0))); c.lineWidth = 1.5; c.setLineDash([3, 9]); c.beginPath(); c.moveTo(A[0], A[1]); c.lineTo(px, py); c.stroke(); c.setLineDash([]);
        const fade = reach < 1 ? 1 - sat((f - 0.8) / 0.2) : 1; c.fillStyle = rgba('#fff', fade); c.beginPath(); c.arc(px, py, 4, 0, 7); c.fill(); L.orb(c, px, py, 26, PAL.gold, 0.6 * fade);
      }
    }
    // trails when together
    if (lt > tJ) for (const [P0, sgn, col] of [[0, -1, PAL.gold], [1, 1, PAL.blue]]) {
      c.strokeStyle = rgba(col, 0.5); c.lineWidth = 3; c.beginPath();
      for (let k = 0; k < 50; k++) { const tt = th - k * 0.03; const x = cx + sgn * Math.cos(tt) * dist, y = cy + sgn * Math.sin(tt) * dist * 0.55; k ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.stroke();
    }
    const glow = 1 + joinedK * 0.9;
    L.orb(c, A[0], A[1], 130 * glow, PAL.gold, 0.55); L.orb(c, B[0], B[1], 130 * glow, PAL.blue, 0.55);
    if (joinedK > 0) L.orb(c, cx, cy, 380 * joinedK, '#ffd9a0', 0.16);
    c.fillStyle = '#fff4d8'; c.beginPath(); c.arc(A[0], A[1], 13, 0, 7); c.fill(); c.fillStyle = '#e4f0ff'; c.beginPath(); c.arc(B[0], B[1], 13, 0, 7); c.fill();
    // floating remembered qualities
    (o.chips || []).forEach((ch, i) => {
      const age = lt - ch.t; if (age < 0 || age > 6.5) return;
      const a = sat(age / 0.8) * (1 - sat((age - 5) / 1.5));
      const ang = ch.ang, rx = 640, ry = 250;
      const x = cx + Math.cos(ang) * rx, y = cy + Math.sin(ang) * ry - age * 6;
      c.globalAlpha = a * 0.95; T(c, ch.text, x, y, { size: 38, style: 'italic', weight: 300, color: '#f6ecd6' }); c.globalAlpha = 1;
    });
    c.restore();
  };

  // ---------- timeline ahead ----------
  L.timeline = function (c, lt, o) {
    const x0 = 260, x1 = 1680, y = o.y || 560;
    c.save();
    const lp = ease.inOutC(sat((lt - o.t0) / 2.4));
    const gr = c.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, rgba(PAL.gold, 0.9)); gr.addColorStop(1, rgba(PAL.gold, 0.15));
    c.strokeStyle = gr; c.lineWidth = 3; c.beginPath(); c.moveTo(x0, y); c.lineTo(lerp(x0, x1, lp), y); c.stroke();
    // now
    const nowA = sat((lt - o.t0) / 1) * (1 - sat((lt - o.t0 - 6) / 2));
    L.orb(c, x0, y, 60, '#fff', 0.6 * nowA); c.fillStyle = '#fff'; c.beginPath(); c.arc(x0, y, 9, 0, 7); c.fill(); T(c, 'NOW', x0, y + 40, { font: 'JetBrains Mono', size: 22, weight: 700, spacing: 5, color: '#fff' });
    o.points.forEach((p, i) => {
      const k = sat((lt - p.t) / 0.9); if (k <= 0) return;
      const e = ease.outBack(k), x = lerp(x0, x1, p.f), up = i % 2 === 0, dir = up ? -1 : 1, stem = (p.stem || 120) * e;
      c.strokeStyle = rgba(p.col || PAL.gold, 0.7); c.lineWidth = 2; c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + dir * stem); c.stroke();
      L.orb(c, x, y, 50 * e, p.col || PAL.gold, 0.7); c.fillStyle = '#fff1cc'; c.beginPath(); c.arc(x, y, 8 * e, 0, 7); c.fill();
      c.globalAlpha = k;
      const ty = y + dir * (stem + 18);
      T(c, p.date, x, ty + dir * 8, { font: 'JetBrains Mono', size: 26, weight: 700, spacing: 4, color: p.col || PAL.gold, base: up ? 'bottom' : 'top' });
      p.lines.forEach((ln, j) => T(c, ln, x, up ? ty - 52 - (p.lines.length - 1 - j) * 52 : ty + 46 + j * 52, { size: 42, style: 'italic', weight: 300, color: '#f6ecd6', base: up ? 'bottom' : 'top' }));
      c.globalAlpha = 1;
    });
    c.restore();
  };

  // ---------- house at night ----------
  L.house = function (c, lt, o) {
    const cx = W / 2, gy = 800;
    c.save();
    L.dust(c, lt, 61, 120, { alpha: 0.7, vy: 1, vx: 1 });
    // ground glow + horizon
    const gl = c.createLinearGradient(0, gy - 60, 0, H); gl.addColorStop(0, 'rgba(255,180,90,0.10)'); gl.addColorStop(1, 'rgba(255,180,90,0)'); c.fillStyle = gl; c.fillRect(0, gy - 60, W, H - gy + 60);
    const lit = o.times.filter((t) => lt >= t).length;
    // house body
    const bw = 640, bh = 300, bx = cx - bw / 2, by = gy - bh;
    c.fillStyle = '#0b0a09'; c.strokeStyle = 'rgba(243,233,210,0.22)'; c.lineWidth = 2;
    c.beginPath(); c.rect(bx, by, bw, bh); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(bx - 40, by); c.lineTo(cx, by - 170); c.lineTo(bx + bw + 40, by); c.closePath(); c.fill(); c.stroke();
    c.fillRect(bx + bw - 130, by - 150, 46, 110); c.strokeRect(bx + bw - 130, by - 150, 46, 110);
    // door
    c.fillStyle = '#120e08'; c.fillRect(cx - 38, gy - 130, 76, 130); c.strokeRect(cx - 38, gy - 130, 76, 130);
    // windows: 7
    const wins = [[bx + 50, by + 40], [bx + 190, by + 40], [bx + 330, by + 40], [bx + 470, by + 40], [bx + 50, by + 170], [bx + 190, by + 170], [bx + 470, by + 170]];
    wins.forEach(([wx, wy], i) => {
      const t = o.times[i]; const k = t === undefined ? 0 : ease.outC(sat((lt - t) / 0.9));
      const flick = 0.92 + 0.08 * Math.sin(lt * 3 + i * 2);
      if (k > 0) { L.orb(c, wx + 55, wy + 55, 210 * k, '#ffb35a', 0.32 * k); }
      c.fillStyle = k > 0 ? U.mix('#1a1408', '#ffcf85', k * flick) : '#0f0e0c'; c.fillRect(wx, wy, 110, 90);
      c.strokeStyle = 'rgba(243,233,210,0.3)'; c.lineWidth = 2; c.strokeRect(wx, wy, 110, 90); c.beginPath(); c.moveTo(wx + 55, wy); c.lineTo(wx + 55, wy + 90); c.moveTo(wx, wy + 45); c.lineTo(wx + 110, wy + 45); c.stroke();
    });
    // path + trees
    c.fillStyle = 'rgba(255,190,110,0.10)'; c.beginPath(); c.moveTo(cx - 38, gy); c.lineTo(cx + 38, gy); c.lineTo(cx + 190, H); c.lineTo(cx - 190, H); c.closePath(); c.fill();
    { const tr = rng(21); for (const sg of [-1, 1]) for (let i = 0; i < 6; i++) {
      const tx = cx + sg * (440 + i * 128 + tr() * 50), th = 130 + tr() * 170, tw = 34 + tr() * 30, tiers = 2 + Math.floor(tr() * 2);
      c.fillStyle = i % 2 ? '#0d0b09' : '#100d0a'; c.strokeStyle = 'rgba(255,190,110,0.13)'; c.lineWidth = 1.5;
      for (let k = 0; k < tiers; k++) { const yy = gy - k * th * 0.28, hh = th * (0.55 - k * 0.1), ww = tw * (1.3 - k * 0.25); c.beginPath(); c.moveTo(tx - ww, yy); c.lineTo(tx, yy - hh); c.lineTo(tx + ww, yy); c.closePath(); c.fill(); c.stroke(); }
    } }
    // warm sparks rising from chimney
    const r = rng(8); for (let i = 0; i < 18; i++) { const ph = (lt * 0.15 + r()) % 1; c.fillStyle = rgba('#ffcf85', (1 - ph) * 0.6); c.fillRect(bx + bw - 107 + Math.sin(ph * 9 + i) * 20, by - 160 - ph * 240, 2.4, 2.4); }
    c.restore();
    return lit;
  };
})();
