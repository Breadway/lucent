import fs from "node:fs";
import path from "node:path";
import { run } from "../src/process.mjs";
import { atomicJSON } from "../src/project.mjs";
const fixture = "examples/conformance/conformance.film.json";
const repeats = 3,
  results = [];
for (const capture of ["png", "rgba"])
  for (let repeat = 0; repeat < repeats; repeat++) {
    const name = `${capture}-${repeat}`,
      base = path.resolve("out/bench/capture-pair", name);
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
          "--capture",
          capture,
          "--work",
          base,
          "--out",
          base + ".mp4",
          "--json",
        ],
        { timeout: 1800000 },
      ),
    );
    results.push({ capture, repeat, ...report });
    atomicJSON("out/bench/capture-pair.json", {
      schemaVersion: 1,
      fixture,
      repeats,
      results,
    });
  }
for (const capture of ["png", "rgba"]) {
  const group = results
    .filter((r) => r.capture === capture)
    .map((r) => r.wallClockSeconds)
    .sort((a, b) => a - b);
  console.log(
    `${capture}: median=${group[1].toFixed(2)}s; exports=${group.map((v) => v.toFixed(2)).join(", ")}`,
  );
}
const a = results
  .filter((r) => r.capture === "png")
  .map((r) => r.exportFps)
  .sort((x, y) => x - y)[1];
const b = results
  .filter((r) => r.capture === "rgba")
  .map((r) => r.exportFps)
  .sort((x, y) => x - y)[1];
console.log(
  `end-to-end throughput change: ${((b / a - 1) * 100).toFixed(1)}%; eligible=false (single portable fixture, requires the full nasty-scene suite)`,
);
