// Score engine for the BOS trailer: a 128 BPM electronic track arranged against the picture.
// Each scene carries `mus` (per-bar chords + which parts play over which beats + a filter curve) and
// `hits` (sound design pinned to visual beats). Deterministic and chunk-safe like audio3: no random
// state (noise offsets and detune come from hashes of absolute time), no history-dependent nodes
// in the graph except fixed-length delay and convolution tails, which the pre-roll reproduces.
(function () {
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  // mid-register voicings, voice-led around A3..A4, plus a bass root
  const VO = {
    A: [57, 61, 64, 69], E: [56, 59, 64, 68], 'F#m': [57, 61, 66, 69], D: [57, 62, 66, 69],
    Bm: [59, 62, 66, 71], G: [59, 62, 67, 71], 'C#m': [56, 61, 64, 68],
  };
  const ROOT = { A: 45, E: 40, 'F#m': 42, D: 38, Bm: 47, G: 43, 'C#m': 49 };
  const TONES = { A: [69, 73, 76, 81, 85], E: [68, 71, 76, 80, 83], 'F#m': [69, 73, 78, 81, 85], D: [69, 74, 78, 81, 86], Bm: [71, 74, 78, 83, 86], G: [71, 74, 79, 83, 86], 'C#m': [68, 73, 76, 80, 85] };
  const hash = (x) => { let h = Math.imul((Math.round(x * 1000) | 0) ^ 0x9e3779b9, 2654435761); h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13; return ((h >>> 0) % 100000) / 100000; };

  window.renderAudioBOS = async function (opts) {
    opts = opts || {};
    const data = window.FILMDATA, sr = 48000, B = 60 / data.bpm;
    const from = opts.from || 0, to = opts.to || (data.duration + 1), PRE = opts.pre === undefined ? 22 : opts.pre;
    const shiftS = Math.max(0, Math.floor((from - PRE) * sr / 128) * 128), shift = shiftS / sr, LEN = to - shift + 0.6;
    const ctx = new OfflineAudioContext(2, Math.ceil(sr * LEN), sr);
    const inWin = (t) => t >= -0.05 && t <= LEN - 0.2;
    const qt = (t) => (Math.round((t + shift) * sr) - shiftS + 0.25) / sr;
    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const biq = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q !== undefined) b.Q.value = q; return b; };
    const fixed = U.rng(9091);
    const ha = (x) => hash(x + shift); // absolute time, so every chunking hashes the same event the same way

    // ---------- buses ----------
    const master = gain(0.3), hp = biq('highpass', 28, 0.7), shelf = ctx.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 6000; shelf.gain.value = 2;
    const shaper = ctx.createWaveShaper(); { const cv = new Float32Array(2048); for (let i = 0; i < 2048; i++) { const x = i / 1024 - 1; cv[i] = Math.tanh(x * 1.4) / Math.tanh(1.4); } shaper.curve = cv; }
    master.connect(hp); hp.connect(shelf); shelf.connect(shaper); shaper.connect(ctx.destination);
    const drums = gain(1); drums.connect(master);
    const music = gain(1); music.connect(master);          // melodic parts, sidechained by the kick
    const duckG = gain(1); duckG.connect(music);
    const fx = gain(1); fx.connect(master);
    function makeIR(len, tau, dark) {
      const n = Math.floor(sr * len), ir = ctx.createBuffer(2, n, sr);
      for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); let lp = 0; for (let i = 0; i < n; i++) { const t = i / sr; lp += ((fixed() * 2 - 1) - lp) * Math.max(0.06, dark - t * 0.2); d[i] = lp * Math.exp(-t / tau) * Math.min(1, i / 400); } }
      return ir;
    }
    const rev = ctx.createConvolver(); rev.buffer = makeIR(3.2, 0.9, 0.55); const revOut = gain(0.55); rev.connect(revOut); revOut.connect(master);
    const room = ctx.createConvolver(); room.buffer = makeIR(0.8, 0.16, 0.8); const roomOut = gain(0.5); room.connect(roomOut); roomOut.connect(master);
    // dotted-eighth ping-pong delay
    const dIn = gain(1), dl = ctx.createDelay(2), dr = ctx.createDelay(2), fb = gain(0.38), dlp = biq('lowpass', 3500, 0.5), mer = ctx.createChannelMerger(2), dOut = gain(0.35);
    dl.delayTime.value = B * 0.75; dr.delayTime.value = B * 0.75; dIn.connect(dl); dl.connect(dr); dr.connect(dlp); dlp.connect(fb); fb.connect(dl);
    dl.connect(mer, 0, 0); dr.connect(mer, 0, 1); mer.connect(dOut); dOut.connect(master); dOut.connect(rev);
    const send = (node, r, d, rm) => { if (r) { const g = gain(r); node.connect(g); g.connect(rev); } if (d) { const g = gain(d); node.connect(g); g.connect(dIn); } if (rm) { const g = gain(rm); node.connect(g); g.connect(room); } };
    const panned = (node, p, dst) => { const pn = ctx.createStereoPanner(); pn.pan.value = p; node.connect(pn); pn.connect(dst); return pn; };
    const nbuf = ctx.createBuffer(1, sr * 3, sr); { const r = U.rng(4242), d = nbuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1; }
    const noise = (t, len, dst) => { const s = ctx.createBufferSource(); s.buffer = nbuf; s.loop = true; s.connect(dst); s.start(t, ha(t + len) * 2.5); s.stop(t + len + 0.05); return s; };
    const env = (g, t, a, peak, d, sus, rel, len) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * sus), t + a + d); if (len) { g.gain.setValueAtTime(Math.max(0.0001, peak * sus), t + len); g.gain.exponentialRampToValueAtTime(0.0001, t + len + rel); } };
    const G = (t) => inWin(t);

    // ---------- drums ----------
    function kick(t, v = 1) { if (!G(t)) return; t = Math.max(0, qt(t));
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(165, t); o.frequency.exponentialRampToValueAtTime(52, t + 0.08); o.frequency.exponentialRampToValueAtTime(44, t + 0.3);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5 * v, t + 0.003); g.gain.exponentialRampToValueAtTime(0.2 * v, t + 0.12); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(g); g.connect(drums); o.start(t); o.stop(t + 0.45);
      const cg = gain(0), cf = biq('highpass', 2500, 0.7); noise(t, 0.012, cf); cf.connect(cg); cg.connect(drums); cg.gain.setValueAtTime(0.35 * v, t); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.01);
      // sidechain the music bus
      duckG.gain.setValueAtTime(0.28, t); duckG.gain.setTargetAtTime(1, t + 0.02, B * 0.16);
    }
    function clap(t, v = 1) { if (!G(t)) return; t = Math.max(0, qt(t));
      const bp = biq('bandpass', 1250, 0.9), g = gain(0); bp.connect(g); const out = panned(g, 0, drums); send(out, 0.18, 0, 0.35);
      noise(t, 0.26, bp);
      [0, 0.011, 0.023].forEach((o) => { g.gain.setValueAtTime(0.9 * v, t + o); g.gain.exponentialRampToValueAtTime(0.06 * v, t + o + 0.009); });
      g.gain.setValueAtTime(0.7 * v, t + 0.034); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      const bd = ctx.createOscillator(), bg = gain(0); bd.frequency.setValueAtTime(220, t); bd.frequency.exponentialRampToValueAtTime(160, t + 0.05); bd.connect(bg); bg.connect(drums); bg.gain.setValueAtTime(0.18 * v, t); bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.08); bd.start(t); bd.stop(t + 0.1);
    }
    function hat(t, v, open) { if (!G(t)) return; t = Math.max(0, qt(t));
      const f = biq('highpass', open ? 7000 : 8500, 0.8), b2 = biq('peaking', 10500, 1); b2.gain.value = 5; const g = gain(0); f.connect(b2); b2.connect(g);
      panned(g, open ? 0.15 : -0.12 + 0.24 * ha(t), drums); noise(t, open ? 0.3 : 0.06, f);
      g.gain.setValueAtTime(v * 3.2, t); g.gain.exponentialRampToValueAtTime(0.0001, t + (open ? 0.24 : 0.04));
    }
    function snareRoll(t, v) { if (!G(t)) return; t = Math.max(0, qt(t));
      const bp = biq('bandpass', 1800, 0.8), g = gain(0); bp.connect(g); panned(g, 0, drums); send(g, 0.2, 0, 0.3); noise(t, 0.12, bp);
      g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      const o = ctx.createOscillator(), og = gain(0); o.type = 'triangle'; o.frequency.setValueAtTime(240, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.06); o.connect(og); og.connect(drums); og.gain.setValueAtTime(v * 0.5, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.08); o.start(t); o.stop(t + 0.1);
    }

    // ---------- tonal parts ----------
    function saws(t, len, freqs, cut, v, spread, dst, o = {}) {
      const bus = gain(0), lp = biq('lowpass', cut, 0.7); bus.connect(lp); lp.connect(dst);
      if (o.cutEnv) { lp.frequency.setValueAtTime(cut * o.cutEnv, t); lp.frequency.exponentialRampToValueAtTime(cut, t + (o.cutT || 0.2)); }
      env(bus, t, o.a || 0.01, v, o.d || 0.1, o.sus === undefined ? 0.8 : o.sus, o.r || 0.25, len);
      freqs.forEach((f, k) => { for (let j = 0; j < spread; j++) {
        const s = ctx.createOscillator(); s.type = 'sawtooth'; s.frequency.value = f; s.detune.value = (j - (spread - 1) / 2) * (o.det || 11) + (hash((t + shift) * 7 + k * 3 + j) - 0.5) * 4;
        const pn = ctx.createStereoPanner(); pn.pan.value = spread > 1 ? ((j / (spread - 1)) - 0.5) * 1.3 : 0; const sg = gain(1 / Math.sqrt(spread * freqs.length));
        s.connect(sg); sg.connect(pn); pn.connect(bus); s.start(t); s.stop(t + len + (o.r || 0.25) + 0.1);
      } });
      return lp;
    }
    function pad(t, len, ch, cut, v) { if (!G(t)) return; t = Math.max(0, qt(t)); const lp = saws(t, len, VO[ch].map(mtof), cut, v, 5, duckG, { a: 0.03, d: 0.3, sus: 0.85, r: 0.35, det: 13 }); send(lp, 0.25, 0.08); }
    function stab(t, ch, cut, v, len = B * 0.4) { if (!G(t)) return; t = Math.max(0, qt(t)); const lp = saws(t, len, VO[ch].map((m) => mtof(m + 12)), cut, v, 3, duckG, { a: 0.004, d: 0.12, sus: 0.35, r: 0.18, cutEnv: 3, cutT: 0.12, det: 9 }); send(lp, 0.22, 0.2); }
    function bass(t, m, len, cut, v) { if (!G(t)) return; t = Math.max(0, qt(t));
      const lp = saws(t, len, [mtof(m)], cut, v, 2, duckG, { a: 0.004, d: 0.08, sus: 0.7, r: 0.05, cutEnv: 2.2, cutT: 0.09, det: 8 });
      const sub = ctx.createOscillator(), sg = gain(0); sub.frequency.value = mtof(m - 12); sub.connect(sg); sg.connect(duckG); env(sg, t, 0.004, v * 0.45, 0.05, 0.9, 0.05, len); sub.start(t); sub.stop(t + len + 0.1);
    }
    function pluck(t, m, v, pan = 0) { if (!G(t)) return; t = Math.max(0, qt(t));
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = gain(0), lp = biq('lowpass', 5200, 1.2); o.type = 'square'; o2.type = 'sawtooth'; o.frequency.value = mtof(m); o2.frequency.value = mtof(m) * 1.005;
      lp.frequency.setValueAtTime(6200, t); lp.frequency.exponentialRampToValueAtTime(900, t + 0.16); o.connect(lp); o2.connect(lp); lp.connect(g);
      const out = panned(g, pan, duckG); send(out, 0.2, 0.32); env(g, t, 0.003, v, 0.18, 0.001, 0.05);
      o.start(t); o2.start(t); o.stop(t + 0.3); o2.stop(t + 0.3);
    }
    function lead(t, m, len, v, glideFrom) { if (!G(t)) return; t = Math.max(0, qt(t));
      const bus = gain(0), lp = biq('lowpass', 4200, 0.9); bus.connect(lp); const out = panned(lp, 0, music); send(out, 0.3, 0.28);
      env(bus, t, 0.012, v, 0.2, 0.75, 0.3, len);
      [-7, 7, 0].forEach((dt, j) => {
        const o = ctx.createOscillator(); o.type = j === 2 ? 'square' : 'sawtooth';
        if (glideFrom) { o.frequency.setValueAtTime(mtof(glideFrom), t); o.frequency.exponentialRampToValueAtTime(mtof(m), t + 0.06); } else o.frequency.value = mtof(m);
        o.detune.value = dt; const vib = ctx.createOscillator(), vg = gain(0); vib.frequency.value = 5.5; vib.connect(vg); vg.connect(o.detune); vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(14, t + Math.min(len, 0.5));
        const og = gain(j === 2 ? 0.25 : 0.4); o.connect(og); og.connect(bus); o.start(t); o.stop(t + len + 0.4); vib.start(t); vib.stop(t + len + 0.4);
      });
    }

    // ---------- sound design ----------
    function impact(t, v = 1) { if (!G(t)) return; t = Math.max(0, qt(t));
      const o = ctx.createOscillator(), g = gain(0); o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(30, t + 1.1); o.connect(g); g.connect(fx); env(g, t, 0.004, 0.85 * v, 0.25, 0.4, 0.8, 0.3); o.start(t); o.stop(t + 1.4);
      const lp = biq('lowpass', 2500, 0.6), ng = gain(0); lp.frequency.setValueAtTime(5000, t); lp.frequency.exponentialRampToValueAtTime(200, t + 0.9); noise(t, 1.2, lp); lp.connect(ng); ng.connect(fx); send(ng, 0.6); env(ng, t, 0.002, 0.45 * v, 0.1, 0.35, 0.8, 0.2);
    }
    function crash(t, v = 1) { if (!G(t)) return; t = Math.max(0, qt(t));
      const f = biq('highpass', 4200, 0.6), g = gain(0); noise(t, 2.6, f); f.connect(g); const out = panned(g, 0, fx); send(out, 0.35); g.gain.setValueAtTime(0.6 * v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
      [3150, 4870, 6230].forEach((fr, k) => { const o = ctx.createOscillator(), og = gain(0); o.type = 'square'; o.frequency.value = fr; const bp = biq('bandpass', fr * 1.5, 3); o.connect(bp); bp.connect(og); og.connect(out); og.gain.setValueAtTime(0.025 * v, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 1.2 - k * 0.2); o.start(t); o.stop(t + 1.3); });
    }
    function riser(t, len, v = 1) { if (!G(t)) return; t = Math.max(0, qt(t));
      const bp = biq('bandpass', 400, 1.2), g = gain(0); bp.frequency.setValueAtTime(400, t); bp.frequency.exponentialRampToValueAtTime(9000, t + len); noise(t, len, bp); bp.connect(g); const out = panned(g, 0, fx); send(out, 0.4);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3 * v, t + len * 0.97); g.gain.linearRampToValueAtTime(0.0001, t + len + 0.02);
      const o = ctx.createOscillator(), og = gain(0), lp = biq('lowpass', 3000, 0.7); o.type = 'sawtooth'; o.frequency.setValueAtTime(mtof(57), t); o.frequency.exponentialRampToValueAtTime(mtof(81), t + len); o.connect(lp); lp.connect(og); og.connect(out);
      og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.07 * v, t + len * 0.97); og.gain.linearRampToValueAtTime(0.0001, t + len + 0.02); o.start(t); o.stop(t + len + 0.05);
    }
    function reverseCym(t, len, v = 1) { if (!G(t)) return; t = Math.max(0, qt(t)); // swells up to t + len
      const f = biq('highpass', 3000, 0.6), g = gain(0); noise(t, len, f); f.connect(g); const out = panned(g, 0, fx); send(out, 0.3);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35 * v, t + len - 0.01); g.gain.linearRampToValueAtTime(0.0001, t + len + 0.005);
    }
    function whoosh(t, v = 1, dir = 1) { if (!G(t)) return; t = Math.max(0, qt(t));
      const bp = biq('bandpass', 300, 1.5), g = gain(0); bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(3200, t + 0.2); bp.frequency.exponentialRampToValueAtTime(400, t + 0.42); noise(t, 0.45, bp); bp.connect(g);
      const pn = ctx.createStereoPanner(); pn.pan.setValueAtTime(-0.8 * dir, t); pn.pan.linearRampToValueAtTime(0.8 * dir, t + 0.42); g.connect(pn); pn.connect(fx); send(pn, 0.25);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4 * v, t + 0.18); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.44);
    }
    function click(t, v = 1) { if (!G(t)) return; t = Math.max(0, qt(t));
      const f = biq('bandpass', 3800, 2), g = gain(0); noise(t, 0.02, f); f.connect(g); g.connect(fx); g.gain.setValueAtTime(0.35 * v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.015);
      const o = ctx.createOscillator(), og = gain(0); o.frequency.value = 1900; o.connect(og); og.connect(fx); og.gain.setValueAtTime(0.06 * v, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.03); o.start(t); o.stop(t + 0.04);
    }
    function ui(t, m, v = 1) { if (!G(t)) return; t = Math.max(0, qt(t)); // two-note FM ping
      [m, m + 7].forEach((n, k) => { const tt = t + k * 0.055, o = ctx.createOscillator(), md = ctx.createOscillator(), mg = gain(mtof(n) * 1.2), g = gain(0);
        md.frequency.value = mtof(n) * 2; md.connect(mg); mg.connect(o.frequency); o.frequency.value = mtof(n); o.connect(g); const out = panned(g, 0.1, fx); send(out, 0.25, 0.25);
        g.gain.setValueAtTime(0.0001, tt); g.gain.exponentialRampToValueAtTime(0.14 * v, tt + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.35);
        mg.gain.setValueAtTime(mtof(n) * 1.2, tt); mg.gain.exponentialRampToValueAtTime(1, tt + 0.2); o.start(tt); md.start(tt); o.stop(tt + 0.4); md.stop(tt + 0.4); });
    }
    function fall(t, len, v = 1) { if (!G(t)) return; t = Math.max(0, qt(t)); // tape-stop style pitch dive
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = gain(0), lp = biq('lowpass', 2400, 0.8); o.type = 'sawtooth'; o2.type = 'square';
      o.frequency.setValueAtTime(mtof(57), t); o.frequency.exponentialRampToValueAtTime(mtof(21), t + len); o2.frequency.setValueAtTime(mtof(45), t); o2.frequency.exponentialRampToValueAtTime(mtof(9), t + len);
      lp.frequency.setValueAtTime(2400, t); lp.frequency.exponentialRampToValueAtTime(120, t + len); o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(fx);
      g.gain.setValueAtTime(0.25 * v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len); o.start(t); o2.start(t); o.stop(t + len + 0.05); o2.stop(t + len + 0.05);
    }
    function stutter(t, ch, n, v = 1) { for (let i = 0; i < n; i++) { const tt = t + i * B / 4; stab(tt, ch, 3000 - i * 150, 0.2 * v * (1 - i / (n + 2)), B / 8); } }
    function tick(t, v = 1) { if (!G(t)) return; t = Math.max(0, qt(t)); const f = biq('bandpass', 2600 + ha(t) * 2400, 2.5), g = gain(0); noise(t, 0.02, f); f.connect(g); g.connect(fx); g.gain.setValueAtTime(0.12 * v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.014); }

    // ---------- arrangement ----------
    const has = (flags, k) => flags.split(' ').includes(k);
    data.scenes.forEach((s) => {
      const m = s.mus; if (!m) return;
      const T0 = s.start - shift, beats = Math.round(s.dur / B);
      const chordAt = (beat) => m.prog[Math.floor(beat / 4) % m.prog.length];
      const cutAt = (beat) => { const f = m.filt; if (!f) return 12000; if (beat <= f[0][0]) return f[0][1]; for (let i = 1; i < f.length; i++) if (beat <= f[i][0]) { const a = f[i - 1], b2 = f[i]; return a[1] * Math.pow(b2[1] / a[1], (beat - a[0]) / (b2[0] - a[0])); } return f[f.length - 1][1]; };
      (m.parts || []).forEach(([b0, b1, flags]) => {
        for (let bi = b0; bi < b1; bi += 0.25) {
          const t = T0 + bi * B, q = Math.round(bi * 4) % 16, beat = bi % 1 === 0, ch = chordAt(bi), cut = cutAt(bi);
          if (beat && has(flags, 'kick')) kick(t, 1);
          if (beat && has(flags, 'kicklo')) kick(t, 0.55);
          if (beat && has(flags, 'half') && Math.floor(bi) % 2 === 0) kick(t, 1);
          if (beat && has(flags, 'clap') && Math.floor(bi) % 2 === 1) clap(t, 1);
          if (has(flags, 'hat') && (q % 2 === 1 || has(flags, 'hat16'))) hat(t, q % 4 === 2 ? 0.16 : (q % 2 ? 0.1 : 0.06), false);
          if (has(flags, 'ohat') && q % 4 === 2) hat(t, 0.13, true);
          if (has(flags, 'roll')) { const prog = (bi - b0) / (b1 - b0), dens = prog < 0.5 ? 1 : prog < 0.75 ? 0.5 : 0.25; if (Math.abs((bi / dens) - Math.round(bi / dens)) < 1e-6) snareRoll(t, 0.25 + 0.5 * prog); }
          if (has(flags, 'bass') && q % 4 === 2) bass(t, ROOT[ch] + (q % 8 === 6 ? 12 : 0), B * 0.45, Math.min(cut, 1400), 0.34);
          if (has(flags, 'bass16') && q % 2 === 1) bass(t, ROOT[ch] + ((q >> 1) % 2 ? 12 : 0), B * 0.22, Math.min(cut, 1600), 0.28);
          if (has(flags, 'pad') && bi % 4 === 0) pad(t, B * 4, ch, Math.min(cut, 5200), 0.34);
          if (has(flags, 'stab') && (q === 2 || q === 6 || q === 10 || q === 14)) stab(t, ch, Math.min(cut, 6500), 0.4);
          if (has(flags, 'arp')) { const tn = TONES[ch], pat = [0, 2, 1, 3, 2, 4, 3, 1]; pluck(t, tn[pat[q % 8]], q % 4 === 0 ? 0.34 : 0.24, ((q % 8) / 7 - 0.5) * 0.6); }
          if (has(flags, 'pulse') && q % 2 === 0) pluck(t, TONES[ch][q % 4 === 0 ? 0 : 2] - 12, 0.2, 0);
        }
      });
      (m.lead || []).forEach(([bt, note, len, glide]) => lead(T0 + bt * B, note, len * B, 0.34, glide));
      (s.hits || []).forEach((h) => {
        const t = T0 + h[0] * B, k = h[1], a = h[2];
        if (k === 'impact') impact(t, a || 1); else if (k === 'crash') crash(t, a || 1); else if (k === 'riser') riser(t, a * B); else if (k === 'rev') reverseCym(t - a * B, a * B);
        else if (k === 'whoosh') whoosh(t, 1, a || 1); else if (k === 'click') click(t, a || 1); else if (k === 'ui') ui(t, a || 81); else if (k === 'fall') fall(t, a * B);
        else if (k === 'stutter') stutter(t, chordAt(h[0]), a || 6); else if (k === 'stab') stab(t, a || chordAt(h[0]), 7000, 0.55, B * 0.9); else if (k === 'kick') kick(t, a || 1);
        else if (k === 'ticks') { for (let i = 0; i < a[0]; i++) tick(t + i * a[1] * B); }
      });
    });

    const buf = await ctx.startRendering();
    const Lc = buf.getChannelData(0), Rc = buf.getChannelData(1);
    const i0 = Math.round(from * sr) - shiftS, i1 = Math.round(to * sr) - shiftS;
    const fin = data.fadeIn || 0.05, fout = data.fadeOut || 2, D = data.duration, out = new Int16Array((i1 - i0) * 2);
    for (let i = i0; i < i1; i++) {
      const tAbs = shift + i / sr, g = 0.8 * Math.min(1, tAbs / fin) * Math.min(1, Math.max(0, (D + 0.4 - tAbs) / fout)), k = i - i0;
      out[2 * k] = Math.max(-32768, Math.min(32767, Lc[i] * g * 32767)); out[2 * k + 1] = Math.max(-32768, Math.min(32767, Rc[i] * g * 32767));
    }
    return out;
  };
})();
