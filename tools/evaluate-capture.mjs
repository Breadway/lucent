import fs from "node:fs";
import { project, atomicJSON } from "../src/project.mjs";
import { openFilm } from "../src/browser.mjs";
const p = project(process.argv[2]),
  film = await openFilm(p, { size: [1920, 1080] });
try {
  const canvas = await film.page.evaluate(() => !!window.__engine.output);
  const result = {
    schemaVersion: 1,
    project: p.id,
    backend: "browser",
    reference: "lossless Chromium PNG",
    webcodecs: {
      available: film.caps.webcodecs,
      canvasSource: canvas,
      eligibleForPromotion: false,
    },
    cef: {
      available: !!process.env.CEF_RENDERER,
      eligibleForPromotion: false,
      reason:
        "CEF frame/surface integration requires a platform-specific bridge and correctness tests.",
    },
  };
  if (canvas && film.caps.webcodecs) {
    result.webcodecs.encoders = await film.page.evaluate(async () => {
      const out = {};
      for (const [name, codec] of [
        ["h264", "avc1.640028"],
        ["av1", "av01.0.08M.08"],
        ["h265", "hvc1.1.6.L120.B0"],
      ]) {
        try {
          out[name] = await VideoEncoder.isConfigSupported({
            codec,
            width: 1920,
            height: 1080,
            bitrate: 30000000,
            framerate: 30,
          });
        } catch (e) {
          out[name] = { supported: false, reason: e.message };
        }
      }
      return out;
    });
  }
  atomicJSON("docs/capture-evaluation.json", result);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await film.close();
}
