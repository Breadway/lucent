// Film runner: deterministic render(t) with scene layers, transitions and post FX.
(function () {
  const { W, H, clamp, sat, rng } = U;
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const SS = Math.max(1, +(new URLSearchParams(location.search).get('ss') || 1));
  window.SS = SS;
  const main = document.getElementById('c'); main.width = W * SS; main.height = H * SS;
  const mctx = main.getContext('2d');
  const layer = mk(W * SS, H * SS), lctx = layer.getContext('2d');
  const comp = mk(W * SS, H * SS), cctx = comp.getContext('2d');
  const BW1 = Math.round(W / 4), BH1 = Math.round(H / 4), BW2 = Math.round(W / 12), BH2 = Math.round(H / 12);
  const b1 = mk(BW1, BH1), b1c = b1.getContext('2d');
  const b2 = mk(BW2, BH2), b2c = b2.getContext('2d');
  const chan = mk(W * SS, H * SS), chc = chan.getContext('2d');
  const down = mk(W, H), dctx = down.getContext('2d'); dctx.imageSmoothingEnabled = true; dctx.imageSmoothingQuality = 'high';
  window.frameDataURL = function (fmt, q) {
    let src = main;
    if (SS > 1) { dctx.setTransform(1, 0, 0, 1, 0, 0); dctx.globalCompositeOperation = 'copy'; dctx.drawImage(main, 0, 0, W, H); src = down; }
    return fmt === 'png' ? src.toDataURL('image/png') : src.toDataURL('image/jpeg', q || 0.92);
  };
  const grain = mk(512, 512);
  {
    const g = grain.getContext('2d'); const id = g.createImageData(512, 512); const r = rng(99);
    for (let i = 0; i < id.data.length; i += 4) { const v = 128 + (r() - 0.5) * 90; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    g.putImageData(id, 0, 0);
  }

  const G = { aberr: 0, flash: 0, shake: 0, zoom: 1, beat: 0, film: null };
  window.G = G;

  function drawSlices(dst, src, t, amt, seed) {
    // horizontal slice displacement
    const r = rng(seed);
    const n = 26; let y = 0;
    for (let i = 0; i < n; i++) {
      const h = Math.floor(H / n) + (i === n - 1 ? H - Math.floor(H / n) * n : 0);
      const dx = (r() < 0.55 ? (r() - 0.5) * amt : 0);
      dst.drawImage(src, 0, y * SS, W * SS, h * SS, dx, y, W, h);
      y += h;
    }
  }

  window.renderFrame = function (t) {
    const film = window.FILM; const data = film.data; const draw = film.draw;
    G.aberr = 0; G.flash = 0; G.shake = 0; G.zoom = 1;
    G.beat = data.bpm ? (((t * data.bpm) / 60) % 1) : 0;
    cctx.setTransform(SS, 0, 0, SS, 0, 0);
    cctx.globalCompositeOperation = 'source-over';
    cctx.globalAlpha = 1; cctx.fillStyle = U.PAL.bg; cctx.fillRect(0, 0, W, H);

    for (let i = 0; i < data.scenes.length; i++) {
      const s = data.scenes[i];
      const ov = s.ov === undefined ? 0.6 : s.ov;
      const fi = s.fi === undefined ? 0.6 : s.fi;
      const end = s.start + s.dur + ov;
      if (t < s.start - 0.001 || t > end) continue;
      const a = sat((t - s.start) / Math.max(fi, 1e-3)) * sat((end - t) / Math.max(ov, 1e-3));
      if (a <= 0) continue;
      const lt = t - s.start;
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, W * SS, H * SS);
      lctx.setTransform(SS, 0, 0, SS, 0, 0);
      lctx.globalAlpha = 1; lctx.globalCompositeOperation = 'source-over';
      lctx.save();
      draw[s.id](lctx, lt, { data: s, dur: s.dur, t, G, idx: i });
      lctx.restore();
      // exit transition fx
      const tout = s.out || 'fade';
      const toEnd = end - t;
      cctx.save();
      { // slow camera drift per scene (push in / pull out + tiny pan)
        const dr = s.drift === undefined ? (i % 2 ? -0.03 : 0.036) : s.drift;
        const pr = sat((t - s.start) / (s.dur + ov));
        const z = 1 + (dr >= 0 ? dr * pr : -dr * (1 - pr));
        const pan = (i % 2 ? 1 : -1) * 14 * (pr - 0.5);
        cctx.translate(W / 2, H / 2); cctx.scale(z, z); cctx.translate(-W / 2 + pan, -H / 2);
      }
      cctx.globalAlpha = tout === 'cut' ? (t < end - 0.001 ? 1 : 0) : a;
      if (tout === 'glitch' && toEnd < ov + 0.25 && toEnd > 0) {
        const k = 1 - toEnd / (ov + 0.25);
        G.aberr = Math.max(G.aberr, 14 * k);
        chc.globalCompositeOperation = 'copy'; chc.drawImage(layer, 0, 0);
        drawSlices(cctx, chan, t, 220 * k, Math.floor(t * 30));
        G.flash = Math.max(G.flash, 0.10 * k * (Math.sin(t * 90) > 0 ? 1 : 0.3));
      } else if (tout === 'zoom' && toEnd < ov + 0.3 && toEnd > 0) {
        const k = 1 - toEnd / (ov + 0.3);
        const z = 1 + 0.25 * k * k;
        cctx.translate(W / 2, H / 2); cctx.scale(z, z); cctx.translate(-W / 2, -H / 2);
        cctx.drawImage(layer, 0, 0, W, H);
      } else if (tout === 'whip' && toEnd < ov + 0.2 && toEnd > 0) {
        const k = 1 - toEnd / (ov + 0.2);
        const dx = -W * 0.35 * k * k;
        for (let j = 0; j < 6; j++) { cctx.globalAlpha = a * (j === 0 ? 1 : 0.22); cctx.drawImage(layer, dx * (1 - j * 0.12), 0, W, H); }
        G.aberr = Math.max(G.aberr, 10 * k);
      } else {
        cctx.drawImage(layer, 0, 0, W, H);
      }
      // entrance glitch
      if (s.in === 'glitch' && t - s.start < 0.5) {
        const k = 1 - (t - s.start) / 0.5;
        G.aberr = Math.max(G.aberr, 12 * k);
      }
      cctx.restore();
    }

    // kick-synced light pulse in beat sections
    if (data.bpm) {
      const cs = data.scenes.find((x) => t >= x.start && t < x.start + x.dur);
      if (cs && cs.mood && cs.mood.beat === true) G.flash = Math.max(G.flash, 0.022 * Math.pow(1 - G.beat, 6));
    }
    // ---- post ----
    const shake = G.shake;
    mctx.setTransform(SS, 0, 0, SS, 0, 0);
    mctx.globalAlpha = 1; mctx.globalCompositeOperation = 'source-over';
    mctx.fillStyle = '#000'; mctx.fillRect(0, 0, W, H);
    const sx = shake ? (Math.sin(t * 71) * shake) : 0, sy = shake ? (Math.cos(t * 63) * shake) : 0;
    mctx.save();
    if (G.zoom !== 1) { mctx.translate(W / 2, H / 2); mctx.scale(G.zoom, G.zoom); mctx.translate(-W / 2, -H / 2); }
    mctx.translate(sx, sy);
    if (G.aberr > 0.6) {
      const ab = G.aberr;
      const chans = [['#ff0000', -ab, 0], ['#00ff00', 0, 0], ['#0000ff', ab, 0]];
      mctx.globalCompositeOperation = 'lighter';
      for (const [col, dx, dy] of chans) {
        chc.setTransform(1, 0, 0, 1, 0, 0);
        chc.globalCompositeOperation = 'copy'; chc.drawImage(comp, 0, 0);
        chc.globalCompositeOperation = 'multiply'; chc.fillStyle = col; chc.fillRect(0, 0, W * SS, H * SS);
        mctx.drawImage(chan, dx, dy, W, H);
      }
      mctx.globalCompositeOperation = 'source-over';
    } else {
      mctx.drawImage(comp, 0, 0, W, H);
    }
    mctx.restore();

    // bloom (classic: soft milky glow; 'clean': thresholded highlights only, keeps text crisp)
    const bl = data.bloom || { a1: 0.55, a2: 0.75, r1: 10, r2: 26, th: false };
    b1c.globalCompositeOperation = 'copy'; b1c.filter = bl.th ? 'brightness(0.62) contrast(3.2)' : 'none'; b1c.drawImage(main, 0, 0, BW1, BH1);
    b1c.globalCompositeOperation = 'source-over'; b1c.filter = 'none';
    const tmp = b2c; tmp.globalCompositeOperation = 'copy'; tmp.filter = 'none'; tmp.drawImage(b1, 0, 0, BW2, BH2);
    mctx.globalCompositeOperation = 'lighter';
    mctx.filter = `blur(${bl.r1 * SS}px)`; mctx.globalAlpha = bl.a1; mctx.drawImage(b1, 0, 0, W, H);
    mctx.filter = `blur(${bl.r2 * SS}px)`; mctx.globalAlpha = bl.a2; mctx.drawImage(b2, 0, 0, W, H);
    mctx.filter = 'none'; mctx.globalAlpha = 1;

    // grain + vignette
    const grainA = data.grain === undefined ? 0.16 : data.grain; // FILMDATA.grain: 0 turns film grain off
    if (grainA > 0) {
      mctx.globalCompositeOperation = 'overlay'; mctx.globalAlpha = grainA;
      const r = rng(Math.floor(t * 30) * 7919);
      mctx.save(); mctx.translate(-Math.floor(r() * 512), -Math.floor(r() * 512));
      mctx.fillStyle = mctx.createPattern(grain, 'repeat'); mctx.fillRect(0, 0, W + 512, H + 512); mctx.restore();
    }
    mctx.globalCompositeOperation = 'source-over'; mctx.globalAlpha = 1;
    { const g = mctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.98); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.62)'); mctx.fillStyle = g; mctx.fillRect(0, 0, W, H); }

    if (G.flash > 0) { mctx.fillStyle = `rgba(255,244,225,${clamp(G.flash, 0, 1)})`; mctx.fillRect(0, 0, W, H); }
    // global fades
    const fin = data.fadeIn || 1.2, fout = data.fadeOut || 2.5;
    const g = sat(t / fin) * sat((data.duration - t) / fout);
    if (g < 1) { mctx.fillStyle = `rgba(0,0,0,${1 - g})`; mctx.fillRect(0, 0, W, H); }
    return true;
  };

  // ---- image sequences (optional) ----
  // A film's draw table may define __seq(t) -> [[name, frameIndex], ...]: the recorded frames it will draw at t.
  // prepFrame(times) loads exactly those (assets/seq/<name>/NNNN.jpg) before rendering, so a render stays a pure
  // function of t; a small cache keeps memory bounded. seqImg(name, i) returns a loaded frame or null.
  const seqCache = new Map();
  window.seqImg = (name, i) => seqCache.get(name + '/' + i) || null;
  const loadSeq = (name, i) => new Promise((res) => {
    const im = new Image(); im.onload = async () => { try { await im.decode(); } catch (e) {} seqCache.set(name + '/' + i, im); res(); };
    im.onerror = () => { console.error('seq frame failed: ' + name + ' ' + i); res(); };
    im.src = `assets/seq/${name}/${String(i).padStart(4, '0')}.jpg`;
  });
  window.seqNeeds = (times) => { const d = window.FILM.draw; if (!d.__seq) return []; const out = new Set(); for (const t of times) for (const [n, i] of d.__seq(t)) out.add(n + '/' + i); return [...out]; };
  window.prepFrame = async (times) => {
    const need = window.seqNeeds(times);
    await Promise.all(need.filter((k) => !seqCache.has(k)).map((k) => { const s = k.lastIndexOf('/'); return loadSeq(k.slice(0, s), +k.slice(s + 1)); }));
    if (!window.SEQ_KEEP && seqCache.size > 60) { const keep = new Set(need); for (const k of [...seqCache.keys()]) { if (seqCache.size <= 40) break; if (!keep.has(k)) seqCache.delete(k); } }
  };

  // ---- motion blur: average n sub-frame renders spread across the shutter (fraction of a frame) ----
  const acc = mk(W * SS, H * SS), actx = acc.getContext('2d');
  window.mbTimes = (t, n, shutter, fps) => Array.from({ length: n }, (_, k) => t + ((k + 0.5) / n - 0.5) * shutter / fps);
  window.renderFrameMB = function (t, n, shutter, fps) {
    if (n <= 1) return window.renderFrame(t);
    const ts = window.mbTimes(t, n, shutter, fps);
    actx.setTransform(1, 0, 0, 1, 0, 0);
    ts.forEach((tt, k) => { window.renderFrame(tt); actx.globalCompositeOperation = 'source-over'; actx.globalAlpha = 1 / (k + 1); actx.drawImage(main, 0, 0); });
    actx.globalAlpha = 1;
    mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.globalCompositeOperation = 'copy'; mctx.drawImage(acc, 0, 0); mctx.globalCompositeOperation = 'source-over';
    return true;
  };
})();
