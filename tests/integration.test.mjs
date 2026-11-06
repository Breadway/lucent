import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PNG } from "pngjs";
import { project } from "../src/project.mjs";
import { openFilm } from "../src/browser.mjs";
import { render } from "../src/render.mjs";
import { probe } from "../src/media.mjs";
import { run } from "../src/process.mjs";
import { serve } from "../src/server.mjs";
const enabled = !!process.env.FILM_INTEGRATION;
test(
  "portable TS bundle, deterministic seeking, and server boundaries",
  { skip: !enabled, timeout: 120000 },
  async () => {
    const p = project("examples/conformance/conformance.film.json"),
      film = await openFilm(p, { size: [640, 360], cpu: true });
    try {
      const a = await film.capture(1, 30);
      await film.capture(3, 90);
      const b = await film.capture(1, 30);
      assert.deepEqual(PNG.sync.read(a.png).data, PNG.sync.read(b.png).data);
      assert.equal(film.timeline.scenes[0].id, "operations");
      const svc = await serve(p);
      try {
        assert.equal((await fetch(svc.url + "/.cache/browser.js")).status, 404);
        assert.equal((await fetch(svc.url + "/../../etc/passwd")).status, 404);
      } finally {
        await svc.close();
      }
    } finally {
      await film.close();
    }
  },
);
test(
  "real H264, H265, AV1 exports; recovery verifies corruption",
  { skip: !enabled, timeout: 240000 },
  async () => {
    const p = project("examples/conformance/conformance.film.json"),
      work = fs.mkdtempSync(path.join(os.tmpdir(), "film-encode-"));
    const opts = {
      width: 640,
      height: 360,
      fps: 30,
      from: 1,
      to: 1.1,
      workers: 1,
      chunk: 3,
      encoder: "software",
      codecs: ["h264", "h265", "av1"],
      bitrate: 3000000,
      cpu: true,
      // Keep the frame files so the third render can prove per-frame repair.
      // Encoded chunks stay restorable from their verified segment either way.
      keepFrames: true,
      work,
      out: path.join(work, "out.mp4"),
      backend: "browser",
    };
    try {
      const report = await render(p, opts);
      assert.equal(report.outputs.length, 3);
      for (const file of report.outputs) {
        const video = (await probe(file))[0];
        assert.equal(Number(video.nb_read_frames), 3);
        assert.equal(video.color_range, "tv");
        const pixels = await run("ffmpeg", [
          "-v",
          "error",
          "-i",
          file,
          "-frames:v",
          "1",
          "-vf",
          "zscale=primariesin=709:transferin=709:matrixin=709:rangein=limited:primaries=709:transfer=709:matrix=709:range=full,format=rgb24",
          "-f",
          "rawvideo",
          "-",
        ]);
        for (const [x, y, value] of [
          [455, 220, 0],
          [475, 220, 32],
          [515, 220, 96],
          [575, 220, 224],
          [595, 220, 255],
        ]) {
          const offset = (y * 640 + x) * 3;
          for (let c = 0; c < 3; c++)
            assert.ok(
              Math.abs(pixels[offset + c] - value) <= 8,
              `Colour/range roundtrip failed: ${file} expected ${value}, got ${pixels[offset + c]}`,
            );
        }
      }
      const second = await render(p, opts);
      assert.equal(second.metrics.framesReused, 3);
      const cache = fs.readdirSync(work).find((n) => n.length === 64);
      const chunk = path.join(work, cache, "30-33");
      // A verified encoded segment is restored without touching its frames, so
      // drop this codec's segment first to force the frame path, then corrupt one
      // frame. The other two are reused and only the corrupt frame is captured.
      fs.rmSync(path.join(chunk, "h264.mp4"));
      fs.rmSync(path.join(chunk, "h264.mp4.json"));
      fs.writeFileSync(path.join(chunk, "30.png"), "corrupt");
      const third = await render(p, opts);
      assert.equal(third.metrics.framesCaptured, 1);
      assert.equal(third.metrics.framesReused, 2);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  },
);
test("canonical Rust RGBA16F conversion", { skip: !enabled }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "film-color-"));
  try {
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([255, 0, 0, 128]);
    const file = path.join(tmp, "red.png");
    fs.writeFileSync(file, PNG.sync.write(png));
    const half = await run("target/release/lucent", ["frame-normalize", file]);
    assert.equal(half.length, 8);
    assert.equal(half.readUInt16LE(0), half.readUInt16LE(6));
    assert.equal(half.readUInt16LE(2), 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test(
  "raw VideoFrame capture preserves Canvas pixels",
  { skip: !enabled, timeout: 120000 },
  async () => {
    const p = project("examples/conformance/conformance.film.json"),
      png = await openFilm(p, { size: [640, 360], cpu: true }),
      raw = await openFilm(p, { size: [640, 360], cpu: true, capture: "rgba" });
    try {
      const a = PNG.sync.read((await png.capture(1, 30)).png).data,
        b = PNG.sync.read((await raw.capture(1, 30)).png).data;
      assert.deepEqual(a, b);
    } finally {
      await png.close();
      await raw.close();
    }
  },
);
