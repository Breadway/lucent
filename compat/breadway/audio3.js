// Score engine (final): musical, dynamic, deterministic. Rendered offline via WebAudio in parallel chunks.
// - Every voice draws its randomness from a per-event seed (absolute time + pitch), the reverb IR and noise
//   table use fixed seeds, and each chunk renders a long pre-roll: chunk seams reproduce the full render.
// - Pads are voice-led (nearest chord tone), the bass walks by step (inversions), scenes end on resolved chords.
// - A five-note theme (A C# E B A) recurs at story moments; lines get a sustained chord tone or a short arpeggio.
// - Scene level arc and master fades are applied to samples in absolute time, after the limiter.
(function () {
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const CH = {
    'F#m': { root: 30, tones: [42, 49, 54, 57, 61, 64] }, D: { root: 26, tones: [38, 45, 50, 54, 57, 62] },
    A: { root: 33, tones: [45, 52, 57, 61, 64, 69] }, E: { root: 28, tones: [40, 47, 52, 56, 59, 64] },
    Bm: { root: 35, tones: [47, 54, 59, 62, 66, 71] }, G: { root: 31, tones: [43, 50, 55, 59, 62, 67] },
  };
  const PCS = { 'F#m': [6, 9, 1], D: [2, 6, 9], A: [9, 1, 4], E: [4, 8, 11], Bm: [11, 2, 6], G: [7, 11, 2] };
  const SC = [54, 57, 59, 61, 64, 66, 69, 71, 73, 76, 78, 81, 83, 85, 88];
  const THEME = { A: [69, 73, 76, 71, 69], D: [74, 78, 81, 76, 74], Fsm: [66, 69, 73, 71, 66] };
  const THEME_GAPS = [0.62, 0.62, 1.15, 0.85];

  const nearest = (pc, ref, lo, hi) => { let best = null, bd = 999; for (let m = lo; m <= hi; m++) if (((m % 12) + 12) % 12 === pc && Math.abs(m - ref) < bd) { bd = Math.abs(m - ref); best = m; } return best; };
  function leadVoicing(prev, name) { // smooth voice leading: each voice moves to the nearest chord tone
    const pcs = PCS[name];
    if (!prev) return [nearest(pcs[0], 52, 45, 60), nearest(pcs[1], 57, 50, 66), nearest(pcs[2], 61, 54, 70), nearest(pcs[0], 64, 58, 74)].sort((a, b) => a - b);
    const out = [];
    for (const p of prev) { const c = pcs.map((pc) => nearest(pc, p, 44, 76)).sort((a, b) => Math.abs(a - p) - Math.abs(b - p)); out.push(c.find((x) => !out.includes(x)) || c[0]); }
    pcs.forEach((pc) => { if (!out.some((m) => ((m % 12) + 12) % 12 === pc)) { // every chord tone must be present
      let bi = 0, bd = -1; out.forEach((m, i) => { const dup = out.filter((x) => ((x % 12) + 12) % 12 === ((m % 12) + 12) % 12).length > 1; const d = dup ? 99 : Math.abs(m - nearest(pc, m, 44, 76)); if (d > bd) { bd = d; bi = i; } }); out[bi] = nearest(pc, out[bi], 44, 76); } });
    return out.sort((a, b) => a - b);
  }
  function leadBass(prev, name) { const pcs = PCS[name]; if (prev === null) return nearest(pcs[0], 44, 38, 52); return pcs.map((pc) => nearest(pc, prev, 38, 52)).sort((a, b) => Math.abs(a - prev) - Math.abs(b - prev))[0]; }

  window.renderAudio3 = async function (opts) {
    opts = opts || {};
    const data = window.FILMDATA, sr = 48000;
    const from = opts.from || 0, to = opts.to || (data.duration + 1), PRE = opts.pre === undefined ? 22 : opts.pre;
    const shiftS = Math.max(0, Math.floor((from - PRE) * sr / 128) * 128), shift = shiftS / sr, LEN = to - shift + 0.6; // shift is a whole number of render quanta, so every event keeps the same sample phase in every chunking
    const ctx = new OfflineAudioContext(2, Math.ceil(sr * LEN), sr);
    const inWin = (t) => t >= -0.02 && t <= LEN - 0.3;
    const qt = (t) => (Math.round((t + shift) * sr) - shiftS + 0.25) / sr; // snap an event time to a sample, biased a quarter-sample off the rounding edge so ceil/floor/round agree in every chunking
    // deterministic randomness: per-voice seed from absolute event time and a key (pitch/id)
    let RS = 1;
    const rnd = () => { RS = (Math.imul(RS, 1664525) + 1013904223) >>> 0; return RS / 4294967296; };
    const sv = (t, k) => { RS = (Math.imul((Math.round((t + shift) * 1000) | 0) ^ 0x9e3779b9, 2654435761) ^ Math.imul((k | 0) + 17, 40503)) >>> 0; if (!RS) RS = 1; rnd(); };
    const fixed = U.rng(424242);
    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const biq = (type, f, q, g) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q !== undefined) b.Q.value = q; if (g !== undefined) b.gain.value = g; return b; };

    // ---------- master ----------
    const levelBus = gain(1), hp = biq('highpass', 34, 0.8), loShelf = biq('lowshelf', 150, 0.7, -8), midCut = biq('peaking', 380, 0.8, -2.5), midCut2 = biq('peaking', 900, 1.0, -3), hiShelf = biq('highshelf', 3200, 0.7, 5);
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -22; comp.ratio.value = 2.4; comp.attack.value = 0.02; comp.release.value = 0.35; comp.knee.value = 14;
    const shaper = ctx.createWaveShaper(); const cur = new Float32Array(2048); for (let i = 0; i < 2048; i++) { const x = i / 1024 - 1; cur[i] = Math.tanh(x * 1.15) / Math.tanh(1.15); } shaper.curve = cur;
    const master = gain(1);
    levelBus.connect(hp); hp.connect(loShelf); loShelf.connect(midCut); midCut.connect(midCut2); midCut2.connect(hiShelf); hiShelf.connect(shaper); shaper.connect(master); master.connect(ctx.destination); // no in-graph compressor: its history-dependent gain made chunks differ; dynamics are handled at mastering, on the assembled file

    // ---------- space ----------
    function makeIR(len, tau, pre, dark) {
      const n = Math.floor(sr * len), ir = ctx.createBuffer(2, n, sr);
      for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); let lp = 0; const off = Math.floor(sr * pre); for (let i = off; i < n; i++) { const t = (i - off) / sr; lp += ((fixed() * 2 - 1) - lp) * Math.max(0.05, dark - t * 0.14); d[i] = lp * Math.exp(-t / tau) * Math.min(1, (i - off) / 900); } }
      return ir;
    }
    const convL = ctx.createConvolver(); convL.buffer = makeIR(6.0, 1.7, 0.035, 0.5);
    const convS = ctx.createConvolver(); convS.buffer = makeIR(1.0, 0.28, 0.006, 0.7);
    const revL = gain(1), revLout = gain(data.reverb || 0.7), revS = gain(1), revSout = gain(0.45);
    revL.connect(convL); convL.connect(revLout); revLout.connect(levelBus); revS.connect(convS); convS.connect(revSout); revSout.connect(levelBus);
    const dl = ctx.createDelay(2), dr = ctx.createDelay(2), fbk = gain(0.34), delIn = gain(1), mer = ctx.createChannelMerger(2), dlp = biq('lowpass', 2600, 0.5), delOut = gain(0.42);
    dl.delayTime.value = 0.42; dr.delayTime.value = 0.63; delIn.connect(dl); dl.connect(fbk); fbk.connect(dr); dr.connect(dl); dl.connect(mer, 0, 0); dr.connect(mer, 0, 1); mer.connect(dlp); dlp.connect(delOut); delOut.connect(levelBus); delOut.connect(revL);
    const noiseBuf = ctx.createBuffer(1, sr * 4, sr); { const nr = U.rng(515151), d = noiseBuf.getChannelData(0); let b0 = 0, b1 = 0, b2 = 0; for (let i = 0; i < d.length; i++) { const w = nr() * 2 - 1; b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; } }
    const noise = (t, len, dst, type, q, f0, f1) => {
      const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
      const f = biq(type, f0, q); f.frequency.setValueAtTime(f0, t); if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + len);
      const g = ctx.createGain(); g.gain.value = 0; s.connect(f); f.connect(g); g.connect(dst); s.start(t, rnd() * 3); s.stop(t + len + 0.2); return g;
    };
    const duckBus = gain(1); duckBus.connect(levelBus);
    const duck = (t) => { if (!inWin(t)) return; t = Math.max(0, qt(t)); duckBus.gain.setValueAtTime(0.55, t); duckBus.gain.linearRampToValueAtTime(1, t + 0.32); };
    const danceLP = biq('lowpass', 12000, 0.5); danceLP.connect(levelBus); // beat bus that can open up
    const out = (node, o = {}) => {
      const pan = ctx.createStereoPanner(); pan.pan.value = o.pan === undefined ? (rnd() - 0.5) * 0.6 : o.pan; node.connect(pan); pan.connect(o.duck ? duckBus : levelBus);
      if (o.rev !== 0) { const a = gain(o.rev === undefined ? 0.6 : o.rev); pan.connect(a); a.connect(revL); }
      if (o.room) { const a = gain(o.room); pan.connect(a); a.connect(revS); }
      if (o.del) { const a = gain(o.del); pan.connect(a); a.connect(delIn); }
      return pan;
    };
    const G = (t) => inWin(t); // guard helper

    // ---------- voices (each: guard, seed, clamp) ----------
    function piano(t, m, v, len, o = {}) { if (!G(t)) return; sv(t, m); t = Math.max(0, qt(t));
      const f = mtof(m), L = len || 3.2;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.006); g.gain.exponentialRampToValueAtTime(v * 0.35, t + 0.35); g.gain.exponentialRampToValueAtTime(0.0001, t + L);
      const c1 = ctx.createOscillator(), c2 = ctx.createOscillator(), c3 = ctx.createOscillator(), md = ctx.createOscillator(), mg = ctx.createGain(), g2 = ctx.createGain(), g3 = ctx.createGain();
      c1.frequency.value = f; c2.frequency.value = f * 2.001; c3.frequency.value = f * 3.003; md.frequency.value = f;
      mg.gain.setValueAtTime(f * 1.1, t); mg.gain.exponentialRampToValueAtTime(f * 0.03, t + 0.7); md.connect(mg); mg.connect(c1.frequency);
      g2.gain.setValueAtTime(0.32, t); g2.gain.exponentialRampToValueAtTime(0.0001, t + L * 0.45); g3.gain.setValueAtTime(0.16, t); g3.gain.exponentialRampToValueAtTime(0.0001, t + L * 0.2);
      c1.connect(g); c2.connect(g2); g2.connect(g); c3.connect(g3); g3.connect(g);
      const lp = biq('lowpass', 9000, 0.4); g.connect(lp);
      out(lp, { pan: Math.max(-0.7, Math.min(0.7, (m - 66) / 30)), rev: o.rev === undefined ? 0.75 : o.rev, room: 0.12, del: o.del === undefined ? 0.18 : o.del });
      const hn = noise(t, 0.05, lp, 'bandpass', 2, 2600); hn.gain.setValueAtTime(v * 0.4, t); hn.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
      [c1, c2, c3, md].forEach((x) => { x.start(t); x.stop(t + L + 0.1); });
    }
    function sparkle(t, m, v, len) { if (!G(t)) return; sv(t, m + 500); t = Math.max(0, qt(t));
      const f = mtof(m), L = len || 4;
      const c1 = ctx.createOscillator(), m1 = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain();
      c1.frequency.value = f; m1.frequency.value = f * 3.5; mg.gain.setValueAtTime(f * 0.9, t); mg.gain.exponentialRampToValueAtTime(f * 0.01, t + L * 0.5); m1.connect(mg); mg.connect(c1.frequency); c1.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + L);
      out(g, { rev: 1, del: 0.5 }); c1.start(t); m1.start(t); c1.stop(t + L + 0.1); m1.stop(t + L + 0.1);
    }
    function pad(t, len, notes, bassN, o = {}) { if (!G(t)) return; sv(t, 901); t = Math.max(0, qt(t));
      const att = o.att || 2.6, rel = 3.2, v = o.v || 0.05;
      const bus = gain(0.0001); bus.gain.setValueAtTime(0.0001, t); bus.gain.exponentialRampToValueAtTime(v, t + att); bus.gain.setValueAtTime(v, t + len); bus.gain.exponentialRampToValueAtTime(0.0001, t + len + rel);
      const lp = biq('lowpass', o.cut || 1150, 0.5), hpf = biq('highpass', 170, 0.6); bus.connect(hpf); hpf.connect(lp);
      const lf = ctx.createOscillator(), lg = gain((o.cut || 1150) * 0.22); lf.frequency.value = 0.05 + rnd() * 0.04; lf.connect(lg); lg.connect(lp.frequency); lf.start(t); lf.stop(t + len + rel + 0.1);
      out(lp, { pan: 0, rev: 0.7, room: 0.05, duck: true });
      notes.forEach((m, k) => {
        for (const dt of [-9, 9]) {
          const s = ctx.createOscillator(); s.type = 'sawtooth'; s.frequency.value = mtof(m); s.detune.value = dt + (rnd() - 0.5) * 4;
          const vib = ctx.createOscillator(), vg = gain(5); vib.frequency.value = 4.6 + rnd() * 0.8; vib.connect(vg); vg.connect(s.detune); vib.start(t + att); vib.stop(t + len + rel + 0.1);
          const gg = gain(0.4), pn = ctx.createStereoPanner(); pn.pan.value = ((k % 2 ? 1 : -1) * (0.15 + k * 0.1)) * (dt < 0 ? -1 : 1); s.connect(gg); gg.connect(pn); pn.connect(bus); s.start(t); s.stop(t + len + rel + 0.1);
        }
      });
      const sb = o.sub || 0.045;
      const b = ctx.createOscillator(), bg = ctx.createGain(); b.frequency.value = mtof(bassN); bg.gain.setValueAtTime(0.0001, t); bg.gain.exponentialRampToValueAtTime(sb, t + att); bg.gain.setValueAtTime(sb, t + len); bg.gain.exponentialRampToValueAtTime(0.0001, t + len + rel); b.connect(bg); bg.connect(levelBus); b.start(t); b.stop(t + len + rel + 0.1);
      const b5 = ctx.createOscillator(), b5g = ctx.createGain(); b5.type = 'triangle'; b5.frequency.value = mtof(bassN + 7); b5g.gain.setValueAtTime(0.0001, t); b5g.gain.exponentialRampToValueAtTime(sb * 0.14, t + att); b5g.gain.setValueAtTime(sb * 0.14, t + len); b5g.gain.exponentialRampToValueAtTime(0.0001, t + len + rel); const l5 = biq('lowpass', 500, 0.5); b5.connect(b5g); b5g.connect(l5); l5.connect(levelBus); b5.start(t); b5.stop(t + len + rel + 0.1);
    }
    function choir(t, len, notes, v) { if (!G(t)) return; sv(t, 902); t = Math.max(0, qt(t));
      const att = 3, rel = 3.5, bus = gain(0.0001); bus.gain.setValueAtTime(0.0001, t); bus.gain.exponentialRampToValueAtTime(v, t + att); bus.gain.setValueAtTime(v, t + len); bus.gain.exponentialRampToValueAtTime(0.0001, t + len + rel);
      const forms = [[800, 5, 1], [1150, 6, 0.55], [2900, 8, 0.25]]; const mix = gain(1);
      forms.forEach(([f, q, gn]) => { const b = biq('bandpass', f, q); const g = gain(gn); mix.connect(b); b.connect(g); g.connect(bus); });
      [notes[1], notes[2], notes[3] + 12, notes[2] + 12].forEach((m) => { for (const dt of [-12, 0, 12]) { const s = ctx.createOscillator(); s.type = 'sawtooth'; s.frequency.value = mtof(m); s.detune.value = dt; const vib = ctx.createOscillator(), vg = gain(9); vib.frequency.value = 5 + rnd(); vib.connect(vg); vg.connect(s.detune); vib.start(t + att); vib.stop(t + len + rel + 0.1); const gg = gain(0.22); s.connect(gg); gg.connect(mix); s.start(t); s.stop(t + len + rel + 0.1); } });
      out(bus, { pan: 0, rev: 0.9, room: 0.05, duck: true });
    }
    function bass(t, m, len, v) { if (!G(t)) return; sv(t, m + 700); t = Math.max(0, qt(t)); const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), lp = biq('lowpass', 420, 0.6); o.frequency.value = mtof(m); o2.type = 'triangle'; o2.frequency.value = mtof(m); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + len); o.connect(g); o2.connect(lp); lp.connect(g); g.connect(levelBus); const r = gain(0.12); g.connect(r); r.connect(revS); o.start(t); o2.start(t); o.stop(t + len + 0.1); o2.stop(t + len + 0.1); }
    function pedal(t, len, v) { if (!G(t)) return; sv(t, 950); t = Math.max(0, qt(t)); const g = gain(0.0001); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 4); g.gain.setValueAtTime(v, t + len); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 3); [[42, 'sine', 1], [54, 'triangle', 0.35]].forEach(([m, ty, gn]) => { const o = ctx.createOscillator(), gg = gain(gn); o.type = ty; o.frequency.value = mtof(m); o.connect(gg); gg.connect(g); o.start(t); o.stop(t + len + 3.2); }); const lp = biq('lowpass', 600, 0.5); g.connect(lp); out(lp, { pan: 0, rev: 0.4 }); }
    function kick(t, v, dst) { if (!G(t)) return; sv(t, 31); t = Math.max(0, qt(t)); const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(58, t + 0.12); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38); o.connect(g); g.connect(dst || levelBus); o.start(t); o.stop(t + 0.45); }
    function snap(t, v, dst) { if (!G(t)) return; sv(t, 32); t = Math.max(0, qt(t)); const g = noise(t, 0.12, dst || levelBus, 'bandpass', 3, 2000); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1); const r = gain(0.35); g.connect(r); r.connect(revS); }
    function shaker(t, v, dst) { if (!G(t)) return; sv(t, 33); t = Math.max(0, qt(t)); const g = noise(t, 0.06, dst || levelBus, 'highpass', 0.7, 7000); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05); }
    function tick(t, v) { if (!G(t)) return; sv(t, 34); t = Math.max(0, qt(t)); const g = noise(t, 0.03, levelBus, 'bandpass', 2.5, 2200 + rnd() * 2600); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.016); }
    function heartbeat(t, v) { if (!G(t)) return; sv(t, 35); t = Math.max(0, qt(t)); const th = (tt, f, vv) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(f * 1.6, tt); o.frequency.exponentialRampToValueAtTime(f, tt + 0.07); g.gain.setValueAtTime(0.0001, tt); g.gain.exponentialRampToValueAtTime(vv, tt + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.32); o.connect(g); g.connect(levelBus); o.start(tt); o.stop(tt + 0.4); const c = noise(tt, 0.04, levelBus, 'bandpass', 2, 1500); c.gain.setValueAtTime(vv * 0.5, tt); c.gain.exponentialRampToValueAtTime(0.0001, tt + 0.03); }; th(t, 66, v); th(t + 0.36, 58, v * 0.65); }
    function boom(t, v) { if (!G(t)) return; sv(t, 36); t = Math.max(0, qt(t)); const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(48, t + 1.4); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9); o.connect(g); g.connect(levelBus); o.start(t); o.stop(t + 2); const n = noise(t, 1.5, levelBus, 'lowpass', 0.5, 3200, 200); n.gain.setValueAtTime(v * 0.35, t); n.gain.exponentialRampToValueAtTime(0.0001, t + 1.4); const r = gain(0.8); n.connect(r); r.connect(revL); }
    function swell(t, len, v) { if (!G(t)) return; sv(t, 37); t = Math.max(0, qt(t)); const n = noise(t, len + 2, levelBus, 'bandpass', 0.7, 500, 2600); n.gain.setValueAtTime(0.0001, t); n.gain.exponentialRampToValueAtTime(v || 0.16, t + len * 0.75); n.gain.exponentialRampToValueAtTime(0.0001, t + len + 1.8); const r = gain(0.7); n.connect(r); r.connect(revL); }
    function glitch(t) { for (let i = 0; i < 14; i++) { const tt = t + i * 0.028; if (!G(tt)) continue; sv(tt, 38 + i); const t2 = Math.max(0, tt + rnd() * 0.012); const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'square'; o.frequency.value = 200 + Math.floor(rnd() * 8) * 173; g.gain.setValueAtTime(0.06, t2); g.gain.setValueAtTime(0.0001, t2 + 0.018); o.connect(g); g.connect(levelBus); o.start(t2); o.stop(t2 + 0.03); const n = noise(t2, 0.03, levelBus, 'highpass', 1, 3000 + rnd() * 4000); n.gain.setValueAtTime(0.07, t2); n.gain.setValueAtTime(0.0001, t2 + 0.02); } }
    function riser(t, len, v) { if (!G(t)) return; sv(t, 39); t = Math.max(0, qt(t)); const n = noise(t, len, levelBus, 'bandpass', 1.4, 300, 7000); n.gain.setValueAtTime(0.0001, t); n.gain.exponentialRampToValueAtTime(v || 0.3, t + len - 0.05); n.gain.linearRampToValueAtTime(0.0001, t + len + 0.03); const r = gain(0.6); n.connect(r); r.connect(revL); }
    function air(t, len, v) { if (!G(t)) return; sv(t, 40); t = Math.max(0, qt(t)); const n = noise(t, len, levelBus, 'bandpass', 0.5, 3500, 7500); n.gain.setValueAtTime(0.0001, t); n.gain.exponentialRampToValueAtTime(v, t + 2); n.gain.setValueAtTime(v, t + len - 2); n.gain.exponentialRampToValueAtTime(0.0001, t + len); const r = gain(0.6); n.connect(r); r.connect(revL); }
    const CM = window.COMIC ? window.COMIC({ ctx, gain, biq, noise, out, G, sv, rnd, qt, mtof, levelBus, revL, revS, snap, shaker, kick }) : null; // comedy layer, opt-in per scene
    function theme(t, key, vel, big, final) {
      const th = THEME[key] || THEME.A; let tt = t;
      th.forEach((m, i) => {
        const last = i === th.length - 1, len = last ? (final ? 13 : 6.5) : 3.4;
        piano(tt, m, vel * (last ? 1.1 : 0.9), len, { rev: 0.85, del: 0.25 });
        if (big) { piano(tt, m - 12, vel * 0.7, len, { rev: 0.8 }); piano(tt + 0.012, m - (key === 'Fsm' ? 3 : 4), vel * 0.45, len, { rev: 0.8 }); }
        tt += THEME_GAPS[i] || 0;
      });
      if (final) [45, 52, 57, 61, 64, 69].forEach((m, k) => piano(tt + k * 0.05, m, vel * 0.5, 13, { rev: 0.9 })); // held A major under the last note
    }

    // ---------- scheduling ----------
    const segsOf = (s) => {
      const md = s.mood || {}; if (md.segs) return md.segs;
      const names = md.chords || ['F#m'], cl = md.chordLen || data.chordLen || 8, o = [];
      for (let t = 0, k = 0; t < s.dur; t += cl, k++) o.push([Math.min(cl, s.dur - t), names[k % names.length]]);
      return o;
    };
    const sceneChordAt = (s, lt) => { let acc = 0; const segs = segsOf(s); for (const [d, n] of segs) { if (lt < acc + d) return CH[n]; acc += d; } return CH[segs[segs.length - 1][1]]; };
    let lineCount = 0, lastVoicing = null, lastBass = null;
    function fragment(t, ch, seed, vel) {
      const up = ch.tones.map((m) => m + 24); const patterns = [[0, 1, 2], [1, 2, 3, 2], [3, 2, 1], [0, 2, 1, 3], [2, 3, 4], [4, 3, 2, 1], [1, 3, 4]];
      const pat = patterns[seed % patterns.length], step = 0.27 + (seed % 3) * 0.04;
      pat.forEach((k, i) => piano(t + i * step, up[k % up.length], vel * (i === pat.length - 1 ? 1.15 : 0.8 + (i % 2) * 0.1), 3.6));
    }

    data.scenes.forEach((s, si) => {
      const srnd = U.rng(7000 + si * 131), srnd_i = (n) => Math.floor(srnd() * n);
      const T0 = s.start - shift, end = T0 + s.dur, md = s.mood || {}, lvl = md.level === undefined ? 0.6 : md.level, hush = md.hush || 0;
      // pads / choir / bass / air per chord segment, voice-led across the whole film
      let acc = 0;
      if (!md.comic) segsOf(s).forEach(([d, name], k) => {
        const t = T0 + acc + (k === 0 ? hush : 0), dd = d - (k === 0 ? hush : 0); acc += d;
        lastVoicing = leadVoicing(lastVoicing, name); lastBass = leadBass(lastBass, name);
        const thin = md.arc && (acc - d) < (s.bin ? s.bin.tJoin : 1e9);
        pad(t, dd + 1.0, lastVoicing, lastBass, { v: thin ? 0.026 : (md.tender ? 0.024 : md.climax ? 0.06 : 0.04), cut: thin ? 700 : md.warm ? 1350 : md.climax ? 1700 : 1150, sub: md.drone ? 0.07 : md.tender ? 0.03 : 0.045, att: k === 0 && md.drone ? 4 : 2.6 });
        if (md.climax || md.finale) choir(t, dd + 0.5, lastVoicing, md.climax ? 0.05 : 0.038);
        if (!md.tender && !md.drone) { bass(t + 0.02, lastBass, Math.min(dd, 4), 0.042); if (dd > 5) bass(t + dd / 2, lastBass + 7, 3, 0.03); }
        air(t, dd + 2, 0.025 * (0.5 + lvl));
      });
      if (md.pedal) pedal(T0, s.dur, 0.05);
      if (md.comic && CM) CM.bed(s, T0, end, md, (lt) => sceneChordAt(s, lt), data);
      // rhythm section synced to the film bpm (public film): kick with sidechain duck, snap, shaker, bass, 8th arps
      if (data.bpm && md.beat) {
        const beat = 60 / data.bpm, from0 = T0 + (md.beatFrom || 0), soft = md.beat === 'soft' ? 0.55 : 1, half = md.beat === 'half';
        for (let t = from0; t < end - 0.05; t += beat) {
          const bi = Math.round((t - T0) / beat), ch = sceneChordAt(s, t - T0);
          if (!half || bi % 2 === 0) { kick(t, 0.22 * soft); duck(t); }
          if (!half && bi % 2 === 1) snap(t, 0.05 * soft);
          shaker(t + beat / 2, (bi % 2 ? 0.02 : 0.03) * soft); if (!half && md.beat !== 'soft') { shaker(t + beat * 0.25, 0.012); shaker(t + beat * 0.75, 0.014); }
          if (md.beat !== 'soft' && bi % 4 === 0) bass(t, leadBassAt(s, t - T0), beat * 1.6, 0.06);
        }
      }
      if (data.bpm && md.arp === true) {
        const beat = 60 / data.bpm, step = beat / 2, pat = [0, 2, 3, 2, 4, 3, 2, 1]; let i = 0;
        for (let t = T0; t < end - 0.2; t += step, i++) { if (i % 8 === 6) continue; const ch = sceneChordAt(s, t - T0); piano(t, ch.tones[pat[i % 8] % ch.tones.length] + 24, i % 4 === 0 ? 0.10 : 0.065, 1.2, { rev: 0.45, del: 0.3 }); }
      }
      // drive: octave-pumping 8th-note bass on the chord root, off-beat hats, a clap on 2 and 4 (opt-in, BOS trailer)
      if (data.bpm && md.drive) {
        const beat = 60 / data.bpm, e8 = beat / 2, from = T0 + (md.driveFrom || 0), to = end - (md.driveCut || 0);
        for (let t = from, i = 0; t < to - 0.02; t += e8, i++) {
          const ch = sceneChordAt(s, t - T0), nm = Object.keys(CH).find((n) => CH[n] === ch), root = nearest(PCS[nm][0], 40, 35, 46);
          bass(t, root + (i % 2 ? 12 : 0), e8 * 0.85, i % 2 ? 0.05 : 0.08);
          if (i % 2 === 1) shaker(t, 0.045);
          if (i % 4 === 2) snap(t, 0.085);
        }
      }
      function leadBassAt(sc, lt) { let a = 0; const ss = segsOf(sc); for (const [d, n] of ss) { if (lt < a + d) return nearest(PCS[n][0], 45, 38, 52); a += d; } return 45; }
      if (md.heart) for (let t = T0 + 0.5; t < end - 1; t += 1.75) heartbeat(t, 0.09);
      if (md.arp === 'light') {
        const beat = 60 / 90, step = beat / 2; let i = 0; const pat = [0, 2, 3, 2, 4, 3, 2, 1];
        for (let t = T0 + 2; t < end - 1.5; t += step, i++) { const ch = sceneChordAt(s, t - T0); if (i % 8 === 7) continue; piano(t, ch.tones[pat[i % 8] % ch.tones.length] + 24, i % 4 === 0 ? 0.11 : 0.075, 1.4, { rev: 0.5, del: 0.35 }); if (i % 2 === 1) shaker(t, 0.018); }
        for (let t = T0 + 2; t < end - 1.5; t += beat) kick(t, 0.16);
      }
      // dance: kick enters filtered when the hands are taken, opens up when he joins the floor
      if (md.dance) {
        const bd = md.bpm || 100, beat = 60 / bd, dFrom = T0 + (md.danceFrom || 8), dOpen = T0 + (md.danceOpen || 12);
        if (dOpen + 1.2 < 0) danceLP.frequency.setValueAtTime(12000, 0);
        else { danceLP.frequency.setValueAtTime(600, 0); danceLP.frequency.setValueAtTime(600, Math.max(0, dOpen - 0.02)); danceLP.frequency.linearRampToValueAtTime(12000, Math.max(0.1, dOpen + 1.2)); }
        let b = 0;
        for (let t = dFrom; t < end - 1; t += beat, b++) {
          const open = t >= dOpen, ch = sceneChordAt(s, t - T0), rootN = nearest(PCS[Object.keys(CH).find((n) => CH[n] === ch)][0], 45, 38, 52);
          if (b % 2 === 0) { kick(t, open ? 0.24 : 0.18, danceLP); duck(t); }
          if (b % 4 === 1 || b % 4 === 3) snap(t, 0.07, danceLP);
          shaker(t + beat / 2, 0.03, danceLP); shaker(t, 0.018, danceLP);
          if (open) {
            if (b % 4 === 0) bass(t, rootN, 0.5, 0.11); if (b % 4 === 2) bass(t, rootN + 7, 0.4, 0.08);
            if (b % 2 === 1) [1, 3, 4].forEach((k, j) => piano(t + beat / 2 + j * 0.012, ch.tones[k] + 24, 0.045, 0.7, { rev: 0.4, del: 0.2 }));
          }
        }
      }
      if (md.stars) for (let t = T0 + 2; t < end - 2; t += 0.9 + srnd() * 1.5) sparkle(t, SC[8 + srnd_i(7)], 0.04 + srnd() * 0.03, 4.5);
      if (md.finale) for (let t = T0 + 6; t < end - 2; t += 1.2 + srnd() * 1.6) sparkle(t, SC[9 + srnd_i(6)], 0.045, 5);
      // letter scene: lonely pings synced to the drifting stars, a longing rise, then the bloom when they meet
      if (md.arc && s.bin) {
        const tJ = s.bin.tJoin, tR = s.bin.tReturn;
        for (let k = 0; ; k++) { const lt = 1 + k * 3.2; if (lt >= tJ - 0.5) break; const ping = lt < tR ? 88 : 88 + Math.round((lt - tR) / (tJ - tR) * 5); sparkle(T0 + lt + 1.7, ping, 0.05, 3.6); }
        riser(T0 + tR, tJ - tR - 0.2, 0.22); boom(T0 + tJ, 0.3);
        [0, 2, 4, 3].forEach((k, i) => piano(T0 + tJ + 0.1 + i * 0.09, CH.D.tones[k] + 24, 0.09, 5));
      }
      if (md.climax) (s.lines || []).forEach((l) => { boom(T0 + l.t - 0.05, 0.11); });
      (s.keys || []).forEach(([t0, n, cps]) => { for (let i = 0; i < n; i++) { if (md.clack && CM) CM.clack(T0 + t0 + i / cps, md.clack === true ? 0.11 : md.clack); else tick(T0 + t0 + i / cps, 0.05 + 0.03 * ((i * 7) % 5) / 5); } });
      // narration: sustained chord tone ('note' style) or a short arpeggio ('arp' style)
      (s.lines || []).forEach((l, li) => {
        if (l.mute || l.s === 'mono' || md.lineStyle === 'none') return; const tt = T0 + l.t, ch = sceneChordAt(s, l.t); lineCount++;
        const v = 0.075 + 0.075 * lvl;
        if (md.lineStyle === 'note') {
          const idx = [3, 4, 2, 3, 4][li % 5]; piano(tt, ch.tones[idx] + 12, v * 0.9, 4.2);
          if (l.hold || (l.size || 0) >= 70) piano(tt, ch.tones[2] + 0, v * 0.8, 5);
        } else {
          fragment(tt, ch, lineCount * 7 + li * 3, v);
          if (l.hold || l.s === 'big') piano(tt, ch.tones[2] + 12, v * 0.9, 5);
          const nw = l.text.split(' ').length; for (let k = 1; k < nw; k++) tick(tt + k * (l.wd || 0.13), 0.010);
        }
      });
      if (si > 0 && !hush && !md.comic && !md.noRiser) riser(T0 - 1.6, 1.5, 0.07 + 0.05 * lvl);
      (s.sfx || []).forEach((x) => {
        const tt = T0 + x.t;
        if (x.type === 'hit') boom(tt, 0.13);
        else if (x.type === 'riser') riser(tt, x.dur || 2.5, 0.2);
        else if (x.type === 'glitch') glitch(tt);
        else if (x.type === 'swell') swell(tt, x.dur || 3, 0.09);
        else if (x.type === 'sub') bass(tt, 42 + [0, 2, 3, 5, 7, 9, 10, 12][(x.n || 0) % 8], 0.9, 0.10);
        else if (x.type === 'blip') piano(tt, SC[(x.n || 0) % SC.length] + 12, x.v || 0.06, 1.6, { rev: 0.5, del: 0.3 });
        else if (x.type === 'note') piano(tt, SC[(x.n || 0) % SC.length] + 12, (x.v || 0.10) * 1.1, x.len || 3.6);
        else if (x.type === 'theme') theme(tt, x.key || 'A', (x.vel || 0.7) * (0.075 + 0.06 * lvl), !!x.big, !!x.final);
        else if (CM && CM.sfx[x.type]) CM.sfx[x.type](tt, x, lvl);
      });
    });

    if (CM) CM.finish();
    const buf = await ctx.startRendering();
    const Lc = buf.getChannelData(0), Rc = buf.getChannelData(1);
    const i0 = Math.round(from * sr) - shiftS, i1 = Math.round(to * sr) - shiftS; // exact integer sample bounds: contiguous chunks, no gaps or overlaps
    const keys = [[0, 0.5]]; data.scenes.forEach((s) => { const lv = (s.mood && s.mood.level !== undefined ? s.mood.level : 0.6); keys.push([s.start + 2.5, 0.15 + lv * 1.05]); });
    const lvlAt = (t) => { if (t <= keys[0][0]) return keys[0][1]; for (let k = 1; k < keys.length; k++) if (t <= keys[k][0]) { const a = keys[k - 1], b = keys[k]; return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]); } return keys[keys.length - 1][1]; };
    const fin = data.fadeIn || 2, fout = data.fadeOut || 5, D = data.duration;
    const outp = new Int16Array((i1 - i0) * 2);
    for (let i = i0; i < i1; i++) {
      const tAbs = shift + i / sr; let g = lvlAt(tAbs) * 0.85;
      g *= Math.min(1, tAbs / fin) * Math.min(1, Math.max(0, (D + 0.4 - tAbs) / fout));
      const k = i - i0; outp[2 * k] = Math.max(-32768, Math.min(32767, Lc[i] * g * 32767)); outp[2 * k + 1] = Math.max(-32768, Math.min(32767, Rc[i] * g * 32767));
    }
    return outp;
  };
})();
