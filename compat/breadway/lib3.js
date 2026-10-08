// Diagram components: code, events, constellation, mesh, stack, ring, pillars, thinking loop.
(function () {
  const { W, H, PAL, clamp, sat, lerp, seg, ease, rng, T, rgba, measure } = U;
  const L = window.L;

  // ---------- typed, syntax-highlighted lua ----------
  const KW = /^(local|function|end|if|then|else|elseif|return|for|do|in|and|or|not|nil|true|false)$/;
  function tokenize(line) {
    const out = []; const re = /(--.*$)|("[^"]*")|([A-Za-z_][A-Za-z0-9_]*)|(\d+)|(\s+)|(.)/g; let m;
    while ((m = re.exec(line))) {
      if (m[1]) out.push([m[1], '#6f7a6a']);
      else if (m[2]) out.push([m[2], '#9fd39a']);
      else if (m[3]) out.push([m[3], KW.test(m[3]) ? '#e6b25e' : (/^(bread|M)$/.test(m[3]) ? '#7fb4ff' : '#eadfc8')]);
      else if (m[4]) out.push([m[4], '#e58a6a']);
      else out.push([m[0], '#a89f8c']);
    }
    return out;
  }
  L.code = function (c, lt, lines, x, y, o = {}) {
    const size = o.size || 30, lh = o.lh || size * 1.6, cps = o.cps || 38, t0 = o.t0 || 0;
    const st = { font: 'JetBrains Mono', size, weight: 400 };
    c.save();
    const cw = measure(c, 'M', st);
    let total = Math.floor(Math.max(0, lt - t0) * cps), caret = null;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]; const shown = Math.min(ln.length, total); total -= ln.length + 4; // small pause per line
      const toks = tokenize(ln.slice(0, shown)); let xx = x;
      for (const [s, col] of toks) { T(c, s, xx, y + i * lh, Object.assign({}, st, { align: 'left', color: col })); xx += cw * s.length; }
      if (shown > 0 && shown < ln.length + 1) caret = [xx, y + i * lh];
      if (total < 0) break;
    }
    if (o.caret !== false && caret && (Math.floor(lt * 2.2) % 2 === 0 || total < 0)) { c.fillStyle = PAL.gold; c.fillRect(caret[0] + 2, caret[1] - size * 0.55, cw * 0.9, size * 1.05); }
    c.restore();
  };

  // event log panel. events: [{t,name,col}] (t relative)
  L.eventlog = function (c, lt, events, x, y, o = {}) {
    const lh = o.lh || 46, size = o.size || 24, max = o.max || 9;
    const vis = events.filter((e) => lt >= e.t);
    c.save();
    const shown = vis.slice(-max);
    for (let i = 0; i < shown.length; i++) {
      const e = shown[i]; const age = shown.length - 1 - i;
      const p = ease.outC(sat((lt - e.t) / 0.4));
      const yy = y + (max - 1 - age) * lh - (1 - p) * 14;
      const a = p * (age === 0 ? 1 : Math.max(0.15, 0.75 - age * 0.09));
      c.globalAlpha = a;
      const ts = (lt - e.t < 0 ? 0 : e.t).toFixed(2).padStart(6, ' ');
      T(c, ts, x, yy, { font: 'JetBrains Mono', size: size - 4, color: PAL.dim, align: 'left' });
      c.fillStyle = e.col || PAL.gold; c.fillRect(x + 100, yy - 8, 8, 16);
      T(c, e.name, x + 124, yy, { font: 'JetBrains Mono', size, color: age === 0 ? '#fff4d8' : '#cfc7b4', align: 'left', weight: age === 0 ? 700 : 400 });
      if (age === 0 && p < 1) { c.fillStyle = rgba(e.col || PAL.gold, 0.25 * (1 - p)); c.fillRect(x - 10, yy - 20, 760, 40); }
    }
    c.restore();
  };

  // ---------- constellation around a hub ----------
  L.constellation = function (c, lt, o) {
    const hub = o.hub, nodes = o.nodes, seed = o.seed || 4, r = rng(seed);
    c.save();
    const hubP = ease.outBack(sat((lt - (o.hubT || 0)) / 0.9));
    // edges
    nodes.forEach((n, i) => {
      const fl = Math.sin(lt * 0.8 + i * 1.7) * 5;
      n._x = n.x + Math.sin(lt * 0.5 + i) * 6; n._y = n.y + fl;
      const p = ease.outC(sat((lt - n.t + 0.2) / 0.8)); if (p <= 0) return;
      const ex = lerp(hub.x, n._x, p), ey = lerp(hub.y, n._y, p);
      const g = c.createLinearGradient(hub.x, hub.y, ex, ey); g.addColorStop(0, rgba(PAL.gold, 0.45)); g.addColorStop(1, rgba(n.col || PAL.blue, 0.45));
      c.strokeStyle = g; c.lineWidth = 1.6; c.beginPath(); c.moveTo(hub.x, hub.y); c.lineTo(ex, ey); c.stroke();
    });
    // pulses
    nodes.forEach((n, i) => {
      if (lt < n.t + 0.6) return;
      const per = 1.9 + ((i * 37) % 10) / 10 * 1.4, off = ((i * 53) % 10) / 10 * per;
      const ph = (((lt - n.t - off) % per) + per) % per / per; // 0..1
      const dir = i % 3 === 0 ? -1 : 1; // some go inward
      const tp = ph < 0.35 ? ph / 0.35 : -1;
      if (tp >= 0) {
        const e = ease.inOutS(tp); const f = dir > 0 ? e : 1 - e;
        const px = lerp(hub.x, n._x, f), py = lerp(hub.y, n._y, f);
        for (let k = 0; k < 7; k++) { const ff = dir > 0 ? Math.max(0, e - k * 0.03) : Math.min(1, 1 - e + k * 0.03); c.globalAlpha = (1 - k / 7) * 0.9; c.fillStyle = k === 0 ? '#fff4d8' : rgba(n.col || PAL.gold, 1); c.beginPath(); c.arc(lerp(hub.x, n._x, ff), lerp(hub.y, n._y, ff), 5 - k * 0.5, 0, 7); c.fill(); }
        c.globalAlpha = 1;
      } else if (ph < 0.6) {
        const k = (ph - 0.35) / 0.25; const tx = dir > 0 ? n._x : hub.x, ty = dir > 0 ? n._y : hub.y;
        c.strokeStyle = rgba(n.col || PAL.gold, (1 - k) * 0.8); c.lineWidth = 2.5; c.beginPath(); c.arc(tx, ty, 20 + k * 46, 0, 7); c.stroke();
      }
    });
    // nodes
    nodes.forEach((n, i) => {
      const p = ease.outBack(sat((lt - n.t) / 0.7)); if (p <= 0) return;
      const rr = (n.r || 15) * p;
      L.orb(c, n._x, n._y, rr * 3.2, n.col || PAL.blue, 0.35);
      c.fillStyle = '#0d0d0d'; c.beginPath(); c.arc(n._x, n._y, rr + 3, 0, 7); c.fill();
      c.strokeStyle = n.col || PAL.blue; c.lineWidth = 3; c.beginPath(); c.arc(n._x, n._y, rr, 0, 7); c.stroke();
      c.fillStyle = n.col || PAL.blue; c.beginPath(); c.arc(n._x, n._y, rr * 0.4, 0, 7); c.fill();
      c.globalAlpha = sat((lt - n.t - 0.1) / 0.5);
      const below = n._y > hub.y - 30 || n.lab === 'below';
      T(c, n.label, n._x, n._y + (below ? rr + 34 : -rr - 30), { font: 'JetBrains Mono', size: n.ls || 26, color: '#d8d0bc', weight: 700 });
      c.globalAlpha = 1;
    });
    // hub
    if (hubP > 0) {
      const pul = 1 + 0.06 * Math.sin(lt * 3) + (o.beat ? 0.08 * Math.pow(1 - o.beat, 3) : 0);
      L.orb(c, hub.x, hub.y, 190 * hubP * pul, PAL.gold, 0.55);
      c.fillStyle = '#120d05'; c.beginPath(); c.arc(hub.x, hub.y, 46 * hubP * pul, 0, 7); c.fill();
      c.strokeStyle = PAL.gold; c.lineWidth = 5; c.beginPath(); c.arc(hub.x, hub.y, 46 * hubP * pul, 0, 7); c.stroke();
      c.strokeStyle = rgba(PAL.gold, 0.4); c.lineWidth = 2;
      c.beginPath(); c.arc(hub.x, hub.y, 70 * hubP * pul, lt * 0.8, lt * 0.8 + 4.2); c.stroke();
      c.globalAlpha = hubP; T(c, hub.label, hub.x, hub.y + 2, { font: 'JetBrains Mono', size: 24, weight: 700, color: '#fff1cc' }); c.globalAlpha = 1;
    }
    c.restore();
  };

  // ---------- homelab mesh ----------
  L.mesh = function (c, lt, o) {
    const N = { aegis: { x: 470, y: 400, c: PAL.blue }, hestia: { x: 1010, y: 540, c: PAL.gold }, atlas: { x: 1500, y: 350, c: PAL.violet }, hermes: { x: 620, y: 800, c: PAL.teal } };
    const E = [['aegis', 'hestia'], ['hestia', 'atlas'], ['hestia', 'hermes'], ['aegis', 'hermes']];
    const T0 = o.t;
    c.save();
    // internet inflow to aegis
    const r = rng(11);
    for (let i = 0; i < 46; i++) {
      const y0 = 120 + r() * 640, sp = 0.18 + r() * 0.2, ph = r();
      const f = ((lt * sp + ph) % 1);
      const x = lerp(-40, N.aegis.x - 40, f), y = lerp(y0, N.aegis.y, ease.inQ(f));
      c.globalAlpha = 0.6 * sat((lt - T0.internet) / 1) * (1 - f * 0.3); c.fillStyle = '#9fb7d9'; c.fillRect(x, y, 3, 3);
    }
    c.globalAlpha = 1;
    // edges
    E.forEach(([a, b], i) => {
      const p = ease.outC(sat((lt - T0.edges - i * 0.35) / 1.0)); if (p <= 0) return;
      const A = N[a], B = N[b];
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2 - 60;
      c.setLineDash([12, 10]); c.lineDashOffset = -lt * 30; c.strokeStyle = 'rgba(200,190,170,0.35)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(A.x, A.y); c.quadraticCurveTo(mx, my, lerp(A.x, B.x, p), lerp(A.y, B.y, p)); c.stroke(); c.setLineDash([]);
      // packets
      if (lt > T0.edges + 1.2) {
        for (let k = 0; k < 3; k++) {
          const per = 2.4 + i * 0.3, ph = (((lt * 0.5 / per * 2 + k / 3 + i * 0.21) % 1) + 1) % 1;
          const dir = (k + i) % 2 ? 1 : -1; const f = dir > 0 ? ph : 1 - ph;
          const qx = (1 - f) * (1 - f) * A.x + 2 * (1 - f) * f * mx + f * f * B.x, qy = (1 - f) * (1 - f) * A.y + 2 * (1 - f) * f * my + f * f * B.y;
          L.orb(c, qx, qy, 26, k === 0 ? PAL.gold : '#cfe3ff', 0.8);
          c.fillStyle = '#fff'; c.fillRect(qx - 2.5, qy - 2.5, 5, 5);
        }
      }
    });
    // nodes
    const names = { aegis: ['Aegis', 'public edge'], hestia: ['Hestia', 'home server'], atlas: ['Atlas', 'trains models'], hermes: ['Hermes', 'where I build'] };
    for (const k of Object.keys(N)) {
      const n = N[k], p = ease.outBack(sat((lt - T0[k]) / 0.8)); if (p <= 0) continue;
      const R = (k === 'hestia' ? 46 : 32) * p;
      L.orb(c, n.x, n.y, R * 4, n.c, 0.4);
      c.fillStyle = '#0d0d0d'; c.beginPath(); c.arc(n.x, n.y, R, 0, 7); c.fill();
      c.strokeStyle = n.c; c.lineWidth = 4; c.beginPath(); c.arc(n.x, n.y, R, 0, 7); c.stroke();
      c.fillStyle = n.c; c.beginPath(); c.arc(n.x, n.y, R * 0.36, 0, 7); c.fill();
      c.globalAlpha = sat((lt - T0[k] - 0.15) / 0.5);
      T(c, names[k][0], n.x, n.y + R + 46, { size: 46, style: 'italic', weight: 400, color: '#f3e9d2' });
      T(c, names[k][1].toUpperCase(), n.x, n.y + R + 86, { font: 'JetBrains Mono', size: 16, spacing: 4, color: PAL.dim });
      c.globalAlpha = 1;
    }
    // container grid beside hestia
    if (lt > T0.grid) {
      const gx = 1240, gy = 690, cell = 28, gap = 8, cols = 8;
      T(c, '37 CONTAINERS', gx, gy - 44, { font: 'JetBrains Mono', size: 16, spacing: 4, color: PAL.dim, align: 'left', alpha: sat((lt - T0.grid) / 0.6) });
      for (let i = 0; i < 37; i++) {
        const cx2 = gx + (i % cols) * (cell + gap), cy2 = gy + Math.floor(i / cols) * (cell + gap);
        const p = ease.outBack(sat((lt - T0.grid - i * 0.05) / 0.4)); if (p <= 0) continue;
        const flick = 0.55 + 0.45 * Math.sin(lt * (1.2 + (i % 5) * 0.4) + i);
        c.fillStyle = rgba(PAL.gold, 0.25 + 0.6 * flick * (i % 7 === 0 ? 1 : 0.5)); const s = cell * p;
        U.roundRect(c, cx2 + (cell - s) / 2, cy2 + (cell - s) / 2, s, s, 6); c.fill();
      }
    }
    // subdomains
    const subs = ['git.breadway.dev', 'breadboard.breadway.dev', 'bos.breadway.dev', 'meet.breadway.dev', 'dl.breadway.dev', 'breadcloud.breadway.dev'];
    if (lt > T0.subs) {
      for (let i = 0; i < subs.length; i++) {
        const p = ease.outC(sat((lt - T0.subs - i * 0.5) / 0.6)); if (p <= 0) continue;
        T(c, subs[i], 110 + (1 - p) * -30, 610 + i * 38, { font: 'JetBrains Mono', size: 20, color: rgba(PAL.blue, 0.9), align: 'left', alpha: p * 0.9 });
      }
      T(c, 'PUBLIC, VIA AEGIS', 110, 566, { font: 'JetBrains Mono', size: 16, spacing: 4, color: PAL.dim, align: 'left', alpha: sat((lt - T0.subs) / 0.6) });
    }
    c.restore();
  };

  // ---------- OS stack ----------
  L.stack = function (c, lt, o) {
    const layers = o.layers, cx = o.cx, y0 = o.y0, h = o.h || 78, w = o.w || 820, step = o.step || 0.7, t0 = o.t0 || 0;
    c.save();
    for (let i = 0; i < layers.length; i++) {
      const ly = layers[i];
      const p = ease.outC(sat((lt - t0 - i * step) / 0.9)); if (p <= 0) continue;
      const top = i === layers.length - 1;
      const yy = y0 - i * (h + 12) - (1 - p) * -140 - (1 - p) * 0;
      const xx = cx + (1 - p) * (i % 2 ? 900 : -900);
      c.globalAlpha = p;
      const skew = 0.0;
      const g = c.createLinearGradient(xx - w / 2, yy, xx + w / 2, yy);
      const base = top ? PAL.gold : ly.col || '#2a2a2a';
      g.addColorStop(0, rgba(base, top ? 0.95 : 0.22)); g.addColorStop(1, rgba(base, top ? 0.6 : 0.10));
      c.fillStyle = g; U.roundRect(c, xx - w / 2, yy - h / 2, w, h, 14); c.fill();
      c.strokeStyle = top ? '#ffe3a6' : 'rgba(243,233,210,0.28)'; c.lineWidth = top ? 3 : 1.6; U.roundRect(c, xx - w / 2, yy - h / 2, w, h, 14); c.stroke();
      if (top) L.orb(c, xx, yy, 360, PAL.gold, 0.35);
      T(c, ly.name, xx - w / 2 + 34, yy + 1, { font: top ? 'Newsreader' : 'JetBrains Mono', size: top ? 50 : 27, weight: top ? 500 : 700, style: top ? 'italic' : 'normal', color: top ? '#1a1206' : '#efe6d0', align: 'left' });
      if (ly.note) T(c, ly.note, xx + w / 2 - 30, yy + 1, { font: 'JetBrains Mono', size: 19, color: top ? '#3a2a10' : PAL.dim, align: 'right' });
      c.globalAlpha = 1;
    }
    c.restore();
  };

  // ---------- personal system ring ----------
  L.sysring = function (c, lt, o) {
    const cx = o.cx, cy = o.cy, R = o.R, tm = o.t;
    const P = ['PLANNING', 'BUILDING', 'SELF-REVIEW', 'QUIET EXAMPLE'];
    const rot = lt * 0.16;
    c.save();
    const ringP = ease.outC(sat((lt - tm.ring) / 1.6));
    // ring
    c.strokeStyle = rgba(PAL.gold, 0.35); c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + ringP * Math.PI * 2); c.stroke();
    L.orb(c, cx, cy, R * 1.5, PAL.gold, 0.10 * ringP);
    // center
    const cp = ease.outBack(sat((lt - tm.center) / 1.0));
    if (cp > 0) { c.globalAlpha = cp; T(c, 'you', cx, cy, { size: 110, style: 'italic', weight: 300, color: '#fff1cc', scale: cp }); c.globalAlpha = 1; }
    // orbiting runner
    if (ringP > 0.99) {
      for (let k = 0; k < 24; k++) {
        const a = rot * 3 - k * 0.045 - Math.PI / 2; c.globalAlpha = (1 - k / 24) * 0.9; c.fillStyle = k === 0 ? '#fff' : PAL.gold;
        c.beginPath(); c.arc(cx + Math.cos(a) * R, cy + Math.sin(a) * R, 6 - k * 0.2, 0, 7); c.fill();
      }
      c.globalAlpha = 1;
    }
    // practices
    for (let i = 0; i < 4; i++) {
      const p = ease.outBack(sat((lt - tm.prac[i]) / 0.8)); if (p <= 0) continue;
      const a = rot + i * Math.PI / 2 - Math.PI / 2, x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
      L.orb(c, x, y, 70 * p, PAL.gold, 0.6);
      c.fillStyle = '#100b04'; c.beginPath(); c.arc(x, y, 20 * p, 0, 7); c.fill();
      c.strokeStyle = PAL.gold; c.lineWidth = 4; c.beginPath(); c.arc(x, y, 20 * p, 0, 7); c.stroke();
      c.globalAlpha = p;
      const ca = Math.cos(a), sa = Math.sin(a), al = ca > 0.35 ? 'left' : ca < -0.35 ? 'right' : 'center';
      const lx = cx + ca * (R + 40) + (al === 'left' ? 30 : al === 'right' ? -30 : 0), ly = cy + sa * (R + 40) + (al === 'center' ? (sa > 0 ? 44 : -44) : 0);
      T(c, P[i], lx, ly, { font: 'JetBrains Mono', size: 24, weight: 700, spacing: 4, color: '#f3e9d2', align: al });
      c.globalAlpha = 1;
    }
    // foundations: two pillars either side
    const F = [['UNYIELDING', 'STANDARDS', cx - R - 420, PAL.blue, tm.f[0]], ['CONSTRUCTIVE', 'SUPPORT', cx + R + 420, PAL.green, tm.f[1]]];
    for (const [a1, a2, x, col, t] of F) {
      const p = ease.outC(sat((lt - t) / 1.3)); if (p <= 0) continue;
      const hh = 420 * p;
      c.fillStyle = rgba(col, 0.10); c.fillRect(x - 3, cy + 210 - hh, 6, hh);
      const g = c.createLinearGradient(0, cy + 210, 0, cy + 210 - hh); g.addColorStop(0, rgba(col, 0.0)); g.addColorStop(1, rgba(col, 0.9));
      c.fillStyle = g; c.fillRect(x - 3, cy + 210 - hh, 6, hh);
      L.orb(c, x, cy + 210 - hh, 60, col, 0.7);
      c.globalAlpha = p; T(c, a1, x, cy + 262, { font: 'JetBrains Mono', size: 24, weight: 700, spacing: 5, color: col }); T(c, a2, x, cy + 296, { font: 'JetBrains Mono', size: 24, weight: 700, spacing: 5, color: col }); c.globalAlpha = 1;
    }
    // failures
    const FN = ['CHASING VALIDATION', 'WASTING POTENTIAL', 'SELF-DECEPTION'];
    const start = [[-0.55, -1], [0.55, -1], [0, -1]];
    for (let i = 0; i < 3; i++) {
      const ta = tm.fail[i], tb = ta + 3.4; if (lt < ta || lt > tb + 2.2) continue;
      const ap = sat((lt - ta) / 3.4);
      const dx = start[i][0], dy = start[i][1]; const nrm = Math.hypot(dx, dy);
      const dist = lerp(720, R + 170, ease.inOutS(ap)) + (lt > tb ? ease.outC(sat((lt - tb) / 1.6)) * 520 : 0);
      const x = cx + (dx / nrm) * dist * 1.0, y = cy + (dy / nrm) * dist * 0.95;
      const fade = lt > tb ? 1 - sat((lt - tb) / 2.0) : sat((lt - ta) / 0.6);
      // jitter spikes
      c.save(); c.translate(x, y); c.rotate(lt * 0.8 + i);
      c.fillStyle = rgba(PAL.red, 0.85 * fade); c.beginPath();
      for (let k = 0; k < 14; k++) { const a = k / 14 * Math.PI * 2, rr = k % 2 ? 14 : 34 + Math.sin(lt * 9 + k) * 4; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      c.closePath(); c.fill(); c.restore();
      L.orb(c, x, y, 90, PAL.red, 0.35 * fade);
      T(c, FN[i], x, y - 60, { font: 'JetBrains Mono', size: 22, weight: 700, spacing: 3, color: rgba(PAL.red, fade), alpha: 1 });
      if (lt > tb && lt < tb + 1.6) { // shockwave
        const k = (lt - tb) / 1.6; c.strokeStyle = rgba(PAL.gold, (1 - k) * 0.9); c.lineWidth = 5 * (1 - k) + 1; c.beginPath(); c.arc(cx, cy, R + 20 + k * 380, 0, 7); c.stroke();
        G.flash = Math.max(G.flash, 0.05 * (1 - k)); G.shake = Math.max(G.shake, 5 * (1 - k));
      }
    }
    c.restore();
  };

  // ---------- pillars ----------
  L.pillars = function (c, lt, o) {
    const cols = o.cols, yB = o.yBase || 930, w = o.w || 400, gapX = o.gapX || 90, h = o.h || 640;
    const total = cols.length * w + (cols.length - 1) * gapX; const x0 = W / 2 - total / 2;
    c.save();
    // floor line + reflection glow
    c.strokeStyle = 'rgba(243,233,210,0.25)'; c.lineWidth = 2; c.beginPath(); c.moveTo(120, yB); c.lineTo(W - 120, yB); c.stroke();
    cols.forEach((col, i) => {
      const p = ease.outC(sat((lt - col.t) / 2.0)); if (p <= 0) return;
      const x = x0 + i * (w + gapX), hh = h * p, y = yB - hh;
      // light cone
      const g0 = c.createLinearGradient(0, y - 400, 0, yB); g0.addColorStop(0, rgba(col.col, 0)); g0.addColorStop(1, rgba(col.col, 0.10));
      c.fillStyle = g0; c.beginPath(); c.moveTo(x + w * 0.2, y - 400); c.lineTo(x + w * 0.8, y - 400); c.lineTo(x + w + 40, yB); c.lineTo(x - 40, yB); c.closePath(); c.fill();
      const g = c.createLinearGradient(0, y, 0, yB); g.addColorStop(0, rgba(col.col, 0.28)); g.addColorStop(1, rgba(col.col, 0.05));
      c.fillStyle = g; U.roundRect(c, x, y, w, hh, 6); c.fill();
      c.strokeStyle = rgba(col.col, 0.7); c.lineWidth = 2; U.roundRect(c, x, y, w, hh, 6); c.stroke();
      c.fillStyle = rgba(col.col, 1); c.fillRect(x, y - 2, w, 5);
      L.orb(c, x + w / 2, y, 220, col.col, 0.4 * p);
      c.globalAlpha = sat((lt - col.t - 1.0) / 0.8);
      T(c, col.head, x + w / 2, y + 64, { font: 'JetBrains Mono', size: 22, weight: 700, spacing: 6, color: col.col });
      c.strokeStyle = rgba(col.col, 0.5); c.beginPath(); c.moveTo(x + 50, y + 100); c.lineTo(x + w - 50, y + 100); c.stroke();
      c.globalAlpha = 1;
      col.items.forEach((it, k) => {
        const ip = ease.outC(sat((lt - col.t - 1.8 - k * 0.55) / 0.7)); if (ip <= 0) return;
        c.globalAlpha = ip;
        T(c, it, x + w / 2 + (1 - ip) * 18, y + 176 + k * 92, { size: 50, style: 'italic', weight: 400, color: '#f6ecd6' });
        c.globalAlpha = 1;
      });
    });
    c.restore();
  };

  // ---------- thinking loop ----------
  L.thinkloop = function (c, lt, o) {
    const cx = o.cx, cy = o.cy, R = o.R, tm = o.t;
    const labels = ['VARIABLES', 'CONSTRAINTS', 'OPTIONS', 'TEST', 'REVISE'];
    const pos = labels.map((_, i) => { const a = -Math.PI / 2 + i * (Math.PI * 2 / 5); return [cx + Math.cos(a) * R * 1.25, cy + Math.sin(a) * R * 0.9, a]; });
    c.save();
    // arcs
    for (let i = 0; i < 5; i++) {
      const p = ease.outC(sat((lt - tm.arcs - i * 0.5) / 0.9)); if (p <= 0) continue;
      const a0 = pos[i][2], a1 = pos[(i + 1) % 5][2] + (i === 4 ? Math.PI * 2 : 0);
      c.strokeStyle = rgba(PAL.gold, 0.4); c.lineWidth = 2.5; c.beginPath();
      for (let s = 0; s <= 40 * p; s++) { const a = lerp(a0, a1, s / 40); const x = cx + Math.cos(a) * R * 1.25, y = cy + Math.sin(a) * R * 0.9; s ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.stroke();
    }
    // nodes
    for (let i = 0; i < 5; i++) {
      const p = ease.outBack(sat((lt - tm.nodes - i * 0.45) / 0.7)); if (p <= 0) continue;
      const [x, y] = pos[i];
      L.orb(c, x, y, 70 * p, PAL.gold, 0.45);
      c.fillStyle = '#100b04'; c.beginPath(); c.arc(x, y, 16 * p, 0, 7); c.fill();
      c.strokeStyle = PAL.gold; c.lineWidth = 4; c.beginPath(); c.arc(x, y, 16 * p, 0, 7); c.stroke();
      c.globalAlpha = p; T(c, labels[i], x, y + (i === 0 ? -46 : i === 1 || i === 4 ? -44 : 48), { font: 'JetBrains Mono', size: 22, weight: 700, spacing: 4, color: '#f3e9d2' }); c.globalAlpha = 1;
    }
    // token
    if (lt > tm.token) {
      const k = (lt - tm.token) * 0.55; const seg = Math.floor(k) % 5; const f = ease.inOutS(k % 1);
      const a0 = pos[seg][2], a1 = pos[(seg + 1) % 5][2] + (seg === 4 ? Math.PI * 2 : 0);
      for (let s = 0; s < 18; s++) {
        const ff = Math.max(0, f - s * 0.025); const a = lerp(a0, a1, ff);
        c.globalAlpha = (1 - s / 18); c.fillStyle = s === 0 ? '#fff' : PAL.gold; c.beginPath(); c.arc(cx + Math.cos(a) * R * 1.25, cy + Math.sin(a) * R * 0.9, 8 - s * 0.35, 0, 7); c.fill();
      }
      c.globalAlpha = 1;
    }
    // domains that get processed (left)
    (o.domains || []).forEach((d, i) => {
      const p = ease.outC(sat((lt - d.t) / 0.8)); if (p <= 0) return;
      const x = 250, y = cy - 150 + i * 150;
      c.globalAlpha = p; T(c, d.name, x, y, { size: 58, style: 'italic', weight: 300, color: '#f3e9d2', align: 'left' });
      c.strokeStyle = rgba(PAL.gold, 0.5); c.lineWidth = 2; c.beginPath(); c.moveTo(x, y + 44); c.lineTo(x + 300 * p, y + 44); c.stroke();
      T(c, d.sub, x, y + 74, { font: 'JetBrains Mono', size: 17, spacing: 3, color: PAL.dim, align: 'left' });
      c.globalAlpha = 1;
    });
    // "people": a shape that will not close
    if (lt > tm.people) {
      const p = sat((lt - tm.people) / 1.6); const px = W - 380, py = cy + 10;
      c.save(); c.globalAlpha = p;
      c.strokeStyle = rgba('#c9c2b0', 0.6); c.lineWidth = 2.5; c.setLineDash([3, 12]); c.lineCap = 'round';
      for (let ring = 0; ring < 3; ring++) {
        c.beginPath();
        for (let s = 0; s <= 60; s++) {
          const a = s / 60 * Math.PI * 2, rr = 100 + ring * 18 + Math.sin(a * 3 + lt * 0.9 + ring) * 14 + U.noise(a * 2 + lt * 0.6 + ring * 7) * 20;
          const x = px + Math.cos(a) * rr, y = py + Math.sin(a) * rr * 0.9; s ? c.lineTo(x, y) : c.moveTo(x, y);
        }
        c.stroke();
      }
      c.setLineDash([]);
      L.orb(c, px, py, 200, '#d9cfff', 0.14);
      T(c, 'people', px, py, { size: 60, style: 'italic', weight: 300, color: '#e9e2d0' });
      c.restore();
    }
    c.restore();
  };
})();
