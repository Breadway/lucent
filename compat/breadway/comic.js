// Comedy layer for the score engine (audio3). Opt-in per scene: mood.comic = 'bounce' | 'sneak' | 'lounge' | 'circus',
// mood.clack (mechanical keyboard for `keys`), and extra sfx types (scratch, trombone, deflate, boing, buzzer, beep, ding,
// slide, rimshot, crickets, honk, tada, flatline, swish, pop, clack). Same determinism rules as audio3: every voice seeds
// from its absolute time (sv) and snaps to a sample (qt); no history-dependent nodes.
(function () {
  window.COMIC = function (E) {
    const { ctx, gain, biq, noise, out, G, sv, rnd, qt, mtof, levelBus, revL, revS, snap, shaker } = E;
    const musicBus = gain(1); musicBus.connect(levelBus); // comic beds go here so a record scratch can cut them
    const cuts = [];
    const osc = (type, f, t, len) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(t); o.stop(t + len + 0.05); return o; };
    const env = (t, a, v, len, shape = 'exp') => { const g = gain(0.0001); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + a); if (shape === 'hold') { g.gain.setValueAtTime(v, t + len - 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + len); } else g.gain.exponentialRampToValueAtTime(0.0001, t + len); return g; };
    const B = (o) => Object.assign({ bus: musicBus }, o);
    const send = (node, o = {}) => { // like out(), but onto the music bus
      const pan = ctx.createStereoPanner(); pan.pan.value = o.pan === undefined ? 0 : o.pan; node.connect(pan); pan.connect(o.dry === false ? gain(0) : (o.bus || levelBus));
      if (o.rev) { const a = gain(o.rev); pan.connect(a); a.connect(revL); }
      if (o.room) { const a = gain(o.room); pan.connect(a); a.connect(revS); }
      return pan;
    };

    // ---------- instruments ----------
    function marimba(t, m, v, len = 0.7, o = {}) { if (!G(t)) return; sv(t, m + 1100); t = Math.max(0, qt(t)); const f = mtof(m);
      const g = env(t, 0.003, v, len), g2 = env(t, 0.002, v * 0.35, len * 0.25);
      osc('sine', f, t, len).connect(g); osc('sine', f * 3.93, t, len).connect(g2); g2.connect(g);
      send(g, B({ pan: o.pan === undefined ? (m - 70) / 40 : o.pan, room: 0.35, rev: 0.12 })); }
    function epiano(t, m, v, len = 1.4) { if (!G(t)) return; sv(t, m + 1200); t = Math.max(0, qt(t)); const f = mtof(m);
      const g = env(t, 0.006, v, len), mod = osc('sine', f * 2, t, len), mg = gain(f * 0.6); mg.gain.setValueAtTime(f * 0.6, t); mg.gain.exponentialRampToValueAtTime(f * 0.02, t + 0.5);
      const c = osc('sine', f, t, len); mod.connect(mg); mg.connect(c.frequency); c.connect(g);
      send(g, B({ pan: (m - 64) / 50, room: 0.3, rev: 0.25 })); }
    function tuba(t, m, len, v) { if (!G(t)) return; sv(t, m + 1300); t = Math.max(0, qt(t)); const f = mtof(m);
      const g = env(t, 0.025, v, len + 0.08), lp = biq('lowpass', 520, 1.2); lp.frequency.setValueAtTime(260, t); lp.frequency.exponentialRampToValueAtTime(900, t + 0.04); lp.frequency.exponentialRampToValueAtTime(380, t + len);
      const a = osc('sawtooth', f, t, len + 0.1), b = osc('square', f * 0.5, t, len + 0.1), bg = gain(0.35); a.connect(lp); b.connect(bg); bg.connect(lp); lp.connect(g);
      send(g, B({ pan: 0, room: 0.2 })); }
    function pizz(t, m, v, len = 0.32) { if (!G(t)) return; sv(t, m + 1400); t = Math.max(0, qt(t)); const f = mtof(m);
      const g = env(t, 0.004, v, len), lp = biq('lowpass', 2400, 2); lp.frequency.setValueAtTime(2400, t); lp.frequency.exponentialRampToValueAtTime(260, t + len);
      osc('sawtooth', f, t, len).connect(lp); osc('triangle', f, t, len).connect(lp); lp.connect(g); send(g, B({ pan: -0.1, room: 0.3, rev: 0.1 })); }
    function wood(t, v, f = 1150) { if (!G(t)) return; sv(t, 1500 + f); t = Math.max(0, qt(t));
      const g = env(t, 0.001, v, 0.07), bp = biq('bandpass', f, 6); osc('sine', f, t, 0.08).connect(bp); bp.connect(g); send(g, B({ pan: 0.35, room: 0.4 })); }
    function clack(t, v) { if (!G(t)) return; sv(t, 1600); t = Math.max(0, qt(t)); const k = 0.8 + rnd() * 0.4;
      const c = noise(t, 0.03, levelBus, 'bandpass', 1.6, 2600 + rnd() * 2400); c.gain.setValueAtTime(v * k, t); c.gain.exponentialRampToValueAtTime(0.0001, t + 0.022);
      const c2 = noise(t + 0.011, 0.03, levelBus, 'bandpass', 2, 1500 + rnd() * 600); c2.gain.setValueAtTime(0.0001, t); c2.gain.setValueAtTime(v * 0.6 * k, t + 0.011); c2.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
      const g = env(t, 0.002, v * 0.9 * k, 0.05); const o = osc('sine', 150 + rnd() * 40, t, 0.06); o.frequency.exponentialRampToValueAtTime(90, t + 0.05); o.connect(g); g.connect(levelBus);
      const r = gain(0.25); c.connect(r); r.connect(revS); }

    // ---------- sound effects ----------
    const sfx = {};
    sfx.clack = (t, x) => clack(t, x.v || 0.12);
    sfx.scratch = (t, x) => { if (!G(t)) return; sv(t, 1700); const t0 = Math.max(0, qt(t));
      const strokes = [[0, 0.09, 700, 3400], [0.09, 0.2, 3400, 500], [0.2, 0.3, 900, 3000], [0.3, 0.42, 3000, 300]];
      strokes.forEach(([a, b, f0, f1], i) => { const n = noise(t0 + a, b - a + 0.02, levelBus, 'bandpass', 3, f0, f1); n.gain.setValueAtTime(0.0001, t0 + a); n.gain.exponentialRampToValueAtTime((x.v || 0.36) * (i % 2 ? 0.8 : 1), t0 + a + 0.015); n.gain.exponentialRampToValueAtTime(0.0001, t0 + b); });
      const o = osc('sawtooth', 160, t0, 0.45), g = env(t0, 0.01, (x.v || 0.36) * 0.12, 0.42), lp = biq('lowpass', 1200, 1);
      [[0, 160], [0.09, 700], [0.2, 140], [0.3, 600], [0.42, 60]].forEach(([a, f]) => o.frequency.linearRampToValueAtTime(f, t0 + a)); o.connect(lp); lp.connect(g); g.connect(levelBus);
      if (x.cut) cuts.push([t, t + x.cut]); };
    sfx.trombone = (t, x) => { const v = x.v || 0.12, notes = [[0, 0.5, 58], [0.55, 0.5, 57], [1.1, 0.5, 56], [1.65, 1.7, 55]];
      notes.forEach(([a, len, m], i) => { const tt = t + a; if (!G(tt)) return; sv(tt, 1800 + i); const t0 = Math.max(0, qt(tt)), f = mtof(m);
        const o = osc('sawtooth', f * 0.97, t0, len + 0.1); o.frequency.setValueAtTime(f * 0.97, t0); o.frequency.exponentialRampToValueAtTime(f, t0 + 0.08);
        if (i === 3) { const vb = osc('sine', 5.5, t0, len), vg = gain(0); vg.gain.setValueAtTime(0, t0); vg.gain.linearRampToValueAtTime(f * 0.03, t0 + 0.5); vb.connect(vg); vg.connect(o.frequency); o.frequency.setValueAtTime(f, t0 + len * 0.6); o.frequency.exponentialRampToValueAtTime(f * 0.94, t0 + len); }
        const lp = biq('lowpass', 500, 4); lp.frequency.setValueAtTime(420, t0); lp.frequency.exponentialRampToValueAtTime(1500, t0 + 0.12); lp.frequency.exponentialRampToValueAtTime(600, t0 + len);
        const g = env(t0, 0.04, v, len + 0.05, 'hold'); o.connect(lp); lp.connect(g); send(g, { room: 0.4, rev: 0.25 }); }); };
    sfx.deflate = (t, x) => { if (!G(t)) return; sv(t, 1900); t = Math.max(0, qt(t)); const len = x.dur || 1.4, v = x.v || 0.12;
      const o = osc('sawtooth', 700, t, len); o.frequency.setValueAtTime(700, t); o.frequency.exponentialRampToValueAtTime(110, t + len);
      const lf = osc('sine', 19, t, len), lg = gain(90); lf.frequency.setValueAtTime(19, t); lf.frequency.linearRampToValueAtTime(9, t + len); lf.connect(lg); lg.connect(o.frequency);
      const bp = biq('bandpass', 900, 2); bp.frequency.setValueAtTime(1200, t); bp.frequency.exponentialRampToValueAtTime(350, t + len);
      const g = env(t, 0.03, v, len, 'hold'); o.connect(bp); bp.connect(g); send(g, { room: 0.3 }); };
    sfx.boing = (t, x) => { if (!G(t)) return; sv(t, 2000); t = Math.max(0, qt(t)); const f = x.f || 160, v = x.v || 0.14, len = 0.7;
      const o = osc('triangle', f, t, len); o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 2.4, t + 0.18); o.frequency.exponentialRampToValueAtTime(f * 1.8, t + len);
      const lf = osc('sine', 16, t, len), lg = gain(f * 0.5); lg.gain.setValueAtTime(f * 0.5, t); lg.gain.exponentialRampToValueAtTime(1, t + len); lf.connect(lg); lg.connect(o.frequency);
      const g = env(t, 0.004, v, len); o.connect(g); send(g, { room: 0.3 }); };
    sfx.buzzer = (t, x) => { if (!G(t)) return; sv(t, 2100); t = Math.max(0, qt(t)); const len = x.dur || 0.5, v = x.v || 0.07;
      const g = env(t, 0.005, v, len, 'hold'), lp = biq('lowpass', 1800, 0.7); osc('square', 92, t, len).connect(lp); osc('sawtooth', 97, t, len).connect(lp); lp.connect(g); send(g, { room: 0.2 }); };
    sfx.beep = (t, x) => { if (!G(t)) return; sv(t, 2200); t = Math.max(0, qt(t)); const len = x.dur || 0.12; const g = env(t, 0.003, x.v || 0.05, len, 'hold'); osc('square', x.f || 1200, t, len).connect(g); send(g, { room: 0.15 }); };
    sfx.flatline = (t, x) => sfx.beep(t, { f: 1000, dur: x.dur || 2.5, v: x.v || 0.035 });
    sfx.ding = (t, x) => { if (!G(t)) return; sv(t, 2300); t = Math.max(0, qt(t)); const f = mtof(x.m || 88), v = x.v || 0.08;
      [[1, 1, 2.2], [2.76, 0.4, 1.2], [5.4, 0.2, 0.6]].forEach(([r, a, len]) => { const g = env(t, 0.002, v * a, len); osc('sine', f * r, t, len).connect(g); send(g, { room: 0.3, rev: 0.4 }); }); };
    sfx.slide = (t, x) => { if (!G(t)) return; sv(t, 2400); t = Math.max(0, qt(t)); const len = x.dur || 0.6, up = x.down ? 0 : 1, f0 = up ? 520 : 1900, f1 = up ? 1900 : 420;
      const o = osc('sine', f0, t, len); o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + len);
      const vb = osc('sine', 7, t, len), vg = gain(18); vb.connect(vg); vg.connect(o.frequency);
      const g = env(t, 0.03, x.v || 0.06, len, 'hold'); o.connect(g); send(g, { room: 0.3 });
      const n = noise(t, len, levelBus, 'bandpass', 4, f0, f1); n.gain.setValueAtTime(0.0001, t); n.gain.exponentialRampToValueAtTime(0.01, t + 0.05); n.gain.exponentialRampToValueAtTime(0.0001, t + len); };
    sfx.rimshot = (t, x) => { const v = x.v || 0.16;
      [[0, 190, 120], [0.16, 150, 95]].forEach(([a, f0, f1], i) => { const tt = t + a; if (!G(tt)) return; sv(tt, 2500 + i); const t0 = Math.max(0, qt(tt));
        const o = osc('sine', f0, t0, 0.3); o.frequency.exponentialRampToValueAtTime(f1, t0 + 0.2); const g = env(t0, 0.003, v, 0.28); o.connect(g); send(g, { room: 0.4 });
        const n = noise(t0, 0.06, levelBus, 'bandpass', 1, 2500); n.gain.setValueAtTime(v * 0.3, t0); n.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05); });
      const tc = t + 0.36; if (!G(tc)) return; sv(tc, 2510); const t0 = Math.max(0, qt(tc));
      const c = noise(t0, 1.3, levelBus, 'highpass', 0.6, 6500); c.gain.setValueAtTime(v * 0.55, t0); c.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2); const r = gain(0.4); c.connect(r); r.connect(revL);
      const k = noise(t0, 0.03, levelBus, 'bandpass', 3, 3200); k.gain.setValueAtTime(v * 0.6, t0); k.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.02); };
    sfx.crickets = (t, x) => { const len = x.dur || 3, v = x.v || 0.03;
      for (let c = 0; c < 2; c++) for (let a = 0.15 + c * 0.37; a < len - 0.3; a += 0.62 + c * 0.21) {
        for (let p = 0; p < 3; p++) { const tt = t + a + p * 0.045; if (!G(tt)) continue; sv(tt, 2600 + c * 10 + p); const t0 = Math.max(0, qt(tt));
          const g = env(t0, 0.004, v, 0.035); osc('sine', 4300 + c * 380, t0, 0.04).connect(g); send(g, { pan: c ? 0.6 : -0.5, room: 0.3, rev: 0.3 }); } } };
    sfx.honk = (t, x) => { [0, 0.28].forEach((a, i) => { const tt = t + a; if (!G(tt)) return; sv(tt, 2700 + i); const t0 = Math.max(0, qt(tt));
      const g = env(t0, 0.01, x.v || 0.08, 0.22, 'hold'), bp = biq('bandpass', 1000, 1.5); osc('square', 370, t0, 0.22).connect(bp); osc('square', 392, t0, 0.22).connect(bp); bp.connect(g); send(g, { room: 0.2 }); }); };
    sfx.tada = (t, x) => { const v = x.v || 0.09, chord = [57, 61, 64, 69];
      [[0, 0.13], [0.16, 1.4]].forEach(([a, len], i) => { const tt = t + a; if (!G(tt)) return; sv(tt, 2800 + i); const t0 = Math.max(0, qt(tt));
        chord.forEach((m) => { const lp = biq('lowpass', 600, 1); lp.frequency.setValueAtTime(600, t0); lp.frequency.exponentialRampToValueAtTime(3200, t0 + 0.06); lp.frequency.exponentialRampToValueAtTime(1200, t0 + len);
          const g = env(t0, 0.02, v / 2, len + 0.05, 'hold'); osc('sawtooth', mtof(m), t0, len + 0.1).connect(lp); lp.connect(g); send(g, { pan: (m - 63) / 20, room: 0.4, rev: 0.3 }); }); }); };
    sfx.swish = (t, x) => { if (!G(t)) return; sv(t, 2900); t = Math.max(0, qt(t)); const len = x.dur || 0.28;
      const n = noise(t, len, levelBus, 'bandpass', 1.2, x.down ? 5000 : 600, x.down ? 500 : 6000); n.gain.setValueAtTime(0.0001, t); n.gain.exponentialRampToValueAtTime(x.v || 0.22, t + len * 0.8); n.gain.exponentialRampToValueAtTime(0.0001, t + len); };
    sfx.pop = (t, x) => { if (!G(t)) return; sv(t, 3000); t = Math.max(0, qt(t)); const f = x.f || 600;
      const o = osc('sine', f, t, 0.1); o.frequency.exponentialRampToValueAtTime(f * 2.5, t + 0.05); const g = env(t, 0.002, x.v || 0.16, 0.09); o.connect(g); send(g, { room: 0.3 }); };
    sfx.mute = (t, x) => { cuts.push([t - 0.08, t + (x.dur || 2)]); }; // silent music cut (deadpan pause)

    // ---------- beds ----------
    const SCALE = (root) => [0, 2, 3, 5, 7, 8, 10, 12].map((s) => root + s);
    function bed(s, T0, end, md, chordAt, data) {
      const kind = md.comic, v = md.comicLevel || 1;
      const bpm0 = md.bpm || data.bpm || 100, bpm1 = md.bpm1 || bpm0;
      const from = T0 + (md.comicFrom || 0), to = end - (md.comicCut || 0.15);
      const rootOf = (lt) => { const ch = chordAt(lt); return ch.tones[0]; }; // e.g. 42 for F#m
      let t = from, i = 0;
      while (t < to - 0.02) {
        const p = (t - T0) / s.dur, bpm = bpm0 + (bpm1 - bpm0) * Math.max(0, Math.min(1, p)), beat = 60 / bpm, lt = t - T0, ch = chordAt(lt), r = rootOf(lt);
        if (kind === 'bounce' || kind === 'circus') {
          const bar = i % 4;
          if (bar === 0) tuba(t, r - 12, beat * 0.42, 0.11 * v);
          if (bar === 2) tuba(t, r - 5, beat * 0.42, 0.10 * v);
          if (bar % 2 === 1) { [1, 2, 3].forEach((k, j) => marimba(t + j * 0.006, ch.tones[k] + 12, 0.045 * v, 0.35)); snap(t, 0.03 * v); }
          wood(t + beat / 2, (kind === 'circus' ? 0.05 : 0.035) * v, i % 2 ? 1400 : 1100);
          if (kind === 'circus') shaker(t + beat * 0.25, 0.02 * v);
          if (i % 16 === 15) { const sc = SCALE(ch.tones[0] + 24); [0, 2, 4, 7].forEach((k, j) => marimba(t + j * beat / 4, sc[k % sc.length] + (k >= 7 ? 0 : 0), 0.05 * v, 0.3)); }
        } else if (kind === 'sneak') {
          const pat = [0, null, 3, null, 4, null, 7, 6, 5, null, 3, null, 0, null, -2, null], st = pat[i % 16];
          if (st !== null) pizz(t, r - 12 + st, 0.12 * v, beat * 0.42);
          if (i % 4 === 2) snap(t, 0.06 * v);
          if (i % 8 === 7) marimba(t + beat / 2, ch.tones[4] + 12, 0.03 * v, 0.25);
          t += beat / 2; i++; continue; // eighth-note grid
        } else if (kind === 'lounge') {
          const bar = i % 4;
          if (bar === 0) pizz(t, r - 12, 0.08 * v, beat * 0.8); if (bar === 2) pizz(t, r - 5, 0.07 * v, beat * 0.8);
          if (bar === 0 || bar === 1.5) [1, 2, 3, 4].forEach((k, j) => epiano(t + j * 0.01, ch.tones[k], 0.03 * v, 1.2));
          if (bar === 2) [1, 2, 3, 4].forEach((k, j) => epiano(t + beat / 2 + j * 0.01, ch.tones[k], 0.026 * v, 1.0));
          shaker(t, 0.012 * v); shaker(t + beat / 2, 0.018 * v);
          if (bar === 1 || bar === 3) wood(t + beat / 2, 0.02 * v, 1700);
        }
        t += beat; i++;
      }
    }
    function finish() { // record-scratch cuts silence the music bus, then let it back in
      cuts.sort((a, b) => a[0] - b[0]);
      for (const [a, b] of cuts) {
        const ta = qt(a + 0.08), tb = qt(b);
        if (tb + 0.3 < 0) continue;
        if (ta + 0.02 <= 0) musicBus.gain.setValueAtTime(0.0001, 0); // cut already in force at this chunk's start
        else { musicBus.gain.setValueAtTime(1, Math.max(0, ta - 0.005)); musicBus.gain.linearRampToValueAtTime(0.0001, ta + 0.02); }
        musicBus.gain.setValueAtTime(0.0001, Math.max(0.002, tb)); musicBus.gain.linearRampToValueAtTime(1, Math.max(0.003, tb + 0.25));
      }
    }
    return { sfx, bed, clack, finish, musicBus };
  };
})();
