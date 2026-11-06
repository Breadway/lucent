#!/usr/bin/env node
// Reproducible measurement of the native frame hand-off.
//
// The export path captures each frame as a 16-bit RGBA PNG, then pipes the
// length-prefixed PNG through `frame-stream`, which decodes it, maps the
// samples through a process-constant sRGB table and writes a 16-bit PPM for
// ffmpeg. This tool measures that decode/convert/write stage for a known
// frame, optionally including ffmpeg's PPM parsing (`--ffmpeg`).
//
// Usage:
//   node tools/bench-frame-handoff.mjs [--frame PATH] [--frames N]
//       [--repeat N] [--ffmpeg] [--out FILE]
//
// Without --frame the tool renders one 1080p still from the conformance
// fixture through the native backend into a temporary directory. The reported
// time includes process start and the one-time 65,536 entry table build, so it
// is the cost a chunk pays once per frame-stream process plus per frame.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { nativeBinary } from "../src/media.mjs";
import { run } from "../src/process.mjs";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const frames = Number(option("--frames", 24));
const repeat = Number(option("--repeat", 3));
const withFfmpeg = args.includes("--ffmpeg");
const out = option("--out");
if (!Number.isInteger(frames) || frames < 1)
  throw Error("--frames must be a positive integer");
if (!Number.isInteger(repeat) || repeat < 1)
  throw Error("--repeat must be a positive integer");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lucent-handoff-"));
try {
  let frame = option("--frame");
  if (!frame) {
    const stills = path.join(scratch, "stills");
    await run("node", [
      "cli.mjs",
      "stills",
      "examples/conformance/conformance.film.json",
      "--backend",
      "native",
      "--size",
      "1080p",
      "--times",
      "1",
      "--out",
      stills,
    ]);
    frame = path.join(stills, "1.000.png");
  }
  const png = fs.readFileSync(frame);
  if (
    png.length < 8 ||
    png.readUInt32BE(0) !== 0x89504e47 ||
    png.readUInt32BE(4) !== 0x0d0a1a0a
  )
    throw Error(`${frame} is not a PNG`);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);

  async function measure() {
    const ff = withFfmpeg
      ? spawn(
          "ffmpeg",
          [
            "-v",
            "error",
            "-f",
            "image2pipe",
            "-framerate",
            "30",
            "-c:v",
            "ppm",
            "-i",
            "-",
            "-f",
            "null",
            "-",
          ],
          { stdio: ["pipe", "ignore", "inherit"] },
        )
      : null;
    const child = spawn(nativeBinary(), ["frame-stream"], {
      stdio: ["pipe", ff ? "pipe" : "ignore", "inherit"],
    });
    if (ff) child.stdout.pipe(ff.stdin);
    const closed = [once(child, "close")];
    if (ff) closed.push(once(ff, "close"));
    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(png.length);
      const wroteLength = child.stdin.write(length);
      const wroteFrame = child.stdin.write(png);
      if (!wroteLength || !wroteFrame) await once(child.stdin, "drain");
    }
    child.stdin.end();
    await Promise.all(closed);
    return performance.now() - start;
  }

  await measure(); // Warm the page cache and the decoder.
  const runs = [];
  for (let i = 0; i < repeat; i++) runs.push(await measure());
  const median = [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  const result = {
    schemaVersion: 1,
    frame,
    pngBytes: png.length,
    width,
    height,
    frames,
    includesFfmpegPpmParse: withFfmpeg,
    runsMs: runs,
    medianMs: median,
    medianMsPerFrame: median / frames,
    framesPerSecond: (frames * 1000) / median,
    binary: nativeBinary(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus()[0]?.model,
  };
  const text = JSON.stringify(result, null, 2);
  if (out) fs.writeFileSync(out, text + "\n");
  console.log(text);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
