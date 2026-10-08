import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PNG } from "pngjs";
import { project, atomicJSON } from "../src/project.mjs";
import { openNative } from "../src/native.mjs";
import { openFilm } from "../src/browser.mjs";
test(
  "native/browser conformance, pinned native determinism and text bounds",
  { skip: !process.env.FILM_NATIVE, timeout: 120000 },
  async () => {
    const p = project("examples/conformance/conformance.film.json"),
      native = await openNative(p, { size: [640, 360] }),
      browser = await openFilm(p, { size: [640, 360], cpu: true });
    try {
      const a = await native.capture(1),
        b = await browser.capture(1, 30),
        overlapNative = await native.capture(3.25),
        overlapBrowser = await browser.capture(3.25, 97);
      await native.capture(3);
      const c = await native.capture(1);
      const x = PNG.sync.read(a.png).data,
        y = PNG.sync.read(b.png).data,
        xn = PNG.sync.read(overlapNative.png).data,
        xb = PNG.sync.read(overlapBrowser.png).data,
        z = PNG.sync.read(c.png).data;
      assert.deepEqual(x, z);
      for (const [pixels, label] of [
        [x, "native"],
        [y, "browser"],
      ]) {
        const offset = (130 * 640 + 560) * 4;
        assert.ok(pixels[offset] > 245, `${label} embedded video red channel`);
        assert.ok(
          pixels[offset + 1] < 8,
          `${label} embedded video green channel`,
        );
        assert.ok(
          pixels[offset + 2] < 8,
          `${label} embedded video blue channel`,
        );
      }
      for (const [pixels, label] of [
        [xn, "native"],
        [xb, "browser"],
      ]) {
        const offset = (50 * 640 + 400) * 4;
        assert.ok(
          pixels[offset] > 12 && pixels[offset + 2] > 30,
          `${label} scene transition overlaps at the declared timestamp`,
        );
      }
      let squared = 0,
        max = 0,
        count = 0;
      for (let i = 0; i < x.length; i++) {
        const d = Math.abs(x[i] - y[i]);
        squared += d * d;
        max = Math.max(max, d);
        if (d) count++;
      }
      const rmse = Math.sqrt(squared / x.length);
      atomicJSON("docs/native-conformance.json", {
        schemaVersion: 1,
        fixture: "operations",
        rmse,
        maxError: max,
        differingChannels: count,
        native: native.caps,
        deterministic: true,
      });
      assert.ok(
        rmse < 25,
        `Native/browser RMSE ${rmse} exceeds initial geometry/text rasterization bound`,
      );
      for (const [px, py, rgb] of [
        [455, 220, [0, 0, 0]],
        [595, 220, [255, 255, 255]],
        [250, 60, [59, 127, 255]],
      ]) {
        for (let c = 0; c < 3; c++)
          assert.ok(
            Math.abs(x[(py * 640 + px) * 4 + c] - rgb[c]) < 3,
            "Solid colour or geometry mismatch",
          );
      }
    } finally {
      await native.close();
      await browser.close();
    }
  },
);
