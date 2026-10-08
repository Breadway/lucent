import fs from "node:fs";
import path from "node:path";
import { run } from "../src/process.mjs";
import { atomicJSON } from "../src/project.mjs";
const fixture = "examples/conformance/conformance.film.json";
const repeats = 3,
  results = [];
for (let repeat = 0; repeat < repeats; repeat++) {
  const base = path.resolve("out/bench/native-pair", "native-" + repeat);
  const report = JSON.parse(
    await run(
      "node",
      [
        "cli.mjs",
        "bench",
        fixture,
        "--size",
        "1080p",
        "--from",
        "1",
        "--to",
        "3",
        "--fps",
        "30",
        "--codec",
        "h264",
        "--encoder",
        "auto",
        "--software-fallback",
        "--workers",
        "1",
        "--chunk",
        "30",
        "--backend",
        "native",
        "--work",
        base,
        "--out",
        base + ".mp4",
        "--json",
      ],
      { timeout: 1800000 },
    ),
  );
  results.push({ repeat, ...report });
  atomicJSON("out/bench/native-pair.json", {
    schemaVersion: 1,
    fixture,
    repeats,
    results,
  });
}
const baseline = JSON.parse(
  fs.readFileSync("out/bench/capture-pair.json"),
).results.filter((r) => r.capture === "png");
const med = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const result = {
  schemaVersion: 1,
  fixture,
  settings: {
    resolution: [1920, 1080],
    fps: 30,
    frames: 60,
    codec: "h264",
    encoder: "auto with explicit software fallback",
    workers: 1,
    range: [1, 3],
  },
  baseline: {
    backend: "browser",
    medianWallSeconds: med(baseline.map((r) => r.wallClockSeconds)),
    steadyStateFps: med(baseline.map((r) => r.steadyStateFps)),
    graphics: baseline[0].environment.acceleration.renderer,
    graphicsActive: baseline[0].hardwareAcceleration.graphicsActive,
  },
  native: {
    backend: "native",
    medianWallSeconds: med(results.map((r) => r.wallClockSeconds)),
    steadyStateFps: med(results.map((r) => r.steadyStateFps)),
    graphics: results[0].environment.acceleration.renderer,
    graphicsActive: results[0].hardwareAcceleration.graphicsActive,
  },
  improvement:
    1 -
    med(results.map((r) => r.wallClockSeconds)) /
      med(baseline.map((r) => r.wallClockSeconds)),
  eligibleForPromotion: false,
  reason:
    "One small portable fixture is insufficient for the representative nasty-scene requirement; compare all required outputs and scenes before promotion.",
};
atomicJSON("docs/benchmarks/portable-native-1080p-h264.json", result);
console.log(JSON.stringify(result, null, 2));
