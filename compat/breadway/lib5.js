// Photo components: framed photos with grade + slow push, circular portraits.
(function () {
  const { W, H, PAL, sat, lerp, ease, T, rgba } = U;
  const L = window.L;
  const cover = (im, w, h, zoom, f) => { // source rect that covers w x h, centred on the faces (f = {x,y} 0..1) when known
    const ar = w / h, iar = im.width / im.height; let sw, sh;
    if (iar > ar) { sh = im.height / zoom; sw = sh * ar; } else { sw = im.width / zoom; sh = sw / ar; }
    const fx = f ? f.x : 0.5, fy = f ? f.y : 0.5;
    return [Math.min(Math.max(0, fx * im.width - sw / 2), im.width - sw), Math.min(Math.max(0, fy * im.height - sh / 2), im.height - sh), sw, sh];
  };
  // o: {x,y (centre), w,h (photo area), rot (deg), t0,t1 (scene-local), cap (caption under the photo), side (+1 from right / -1 from left), lt}
  L.photo = function (c, lt, name, o) {
    const im = window.IMG[name]; if (!im) return;
    const fi = sat((lt - o.t0) / 0.9), fo = 1 - sat((lt - o.t1) / 0.9); const a = ease.outC(fi) * fo; if (a <= 0.003) return;
    const prog = sat((lt - o.t0) / (o.t1 - o.t0)), zoom = 1 + 0.07 * prog;
    const slide = (1 - ease.outC(fi)) * 46 * (o.side || 0);
    const pad = 12, capH = o.cap ? 46 : 0, fw = o.w + pad * 2, fh = o.h + pad * 2 + capH;
    c.save(); c.globalAlpha = a * (o.alpha === undefined ? 0.95 : o.alpha);
    c.translate(o.x + slide, o.y); c.rotate(((o.rot || 0) + (1 - fi) * (o.side || 0) * 2.5) * Math.PI / 180);
    // shadow + warm print frame
    c.shadowColor = 'rgba(0,0,0,0.65)'; c.shadowBlur = 34; c.shadowOffsetY = 14;
    c.fillStyle = '#e9dfc8'; U.roundRect(c, -fw / 2, -fh / 2, fw, fh, 7); c.fill();
    c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0;
    c.save(); U.roundRect(c, -o.w / 2, -fh / 2 + pad, o.w, o.h, 3); c.clip();
    const [sx, sy, sw, sh] = cover(im, o.w, o.h, zoom, window.FOCUS && window.FOCUS[name]);
    c.drawImage(im, sx, sy, sw, sh, -o.w / 2, -fh / 2 + pad, o.w, o.h);
    // warm grade and edge falloff so the print sits in the film's palette
    c.fillStyle = 'rgba(255,170,90,0.10)'; c.fillRect(-o.w / 2, -fh / 2 + pad, o.w, o.h);
    const g = c.createRadialGradient(0, -fh / 2 + pad + o.h / 2, Math.min(o.w, o.h) * 0.35, 0, -fh / 2 + pad + o.h / 2, Math.max(o.w, o.h) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.38)'); c.fillStyle = g; c.fillRect(-o.w / 2, -fh / 2 + pad, o.w, o.h);
    if (o.overlay) { // text set on the lower part of the photo
      const oy = -fh / 2 + pad + o.h, gg = c.createLinearGradient(0, oy - o.h * 0.42, 0, oy);
      gg.addColorStop(0, 'rgba(0,0,0,0)'); gg.addColorStop(1, 'rgba(0,0,0,0.72)'); c.fillStyle = gg; c.fillRect(-o.w / 2, oy - o.h * 0.42, o.w, o.h * 0.42);
      o.overlay.forEach((ln, i) => T(c, ln, 0, oy - 26 - (o.overlay.length - 1 - i) * 40, { size: o.overlaySize || 32, style: 'italic', weight: 400, color: '#fff1cc' }));
    }
    c.restore();
    if (o.cap) T(c, o.cap, 0, fh / 2 - capH / 2 - 2, { font: 'JetBrains Mono', size: 22, weight: 700, spacing: 4, color: '#3a3020' });
    c.restore();
  };
  L.avatar = function (c, name, cx, cy, r, ring, a) {
    const im = window.IMG[name]; if (!im || a <= 0) return;
    c.save(); c.globalAlpha = a;
    L.orb(c, cx, cy, r * 2.2, ring || PAL.gold, 0.35);
    c.beginPath(); c.arc(cx, cy, r, 0, 7); c.save(); c.clip();
    c.drawImage(im, 0, 0, im.width, im.height, cx - r, cy - r, r * 2, r * 2);
    c.fillStyle = 'rgba(255,170,90,0.08)'; c.fillRect(cx - r, cy - r, r * 2, r * 2); c.restore();
    c.strokeStyle = ring || PAL.gold; c.lineWidth = 4; c.beginPath(); c.arc(cx, cy, r + 3, 0, 7); c.stroke();
    c.restore();
  };
})();
