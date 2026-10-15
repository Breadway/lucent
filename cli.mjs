#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  project,
  resolution,
  number,
  frameRate,
  sceneBackends,
  atomicJSON,
} from "./src/project.mjs";
import { openFilm as openBrowser, browserPath } from "./src/browser.mjs";
import { openNative } from "./src/native.mjs";
import { nativeCapabilities } from "./src/capabilities.mjs";
const openFilm = (p, o) =>
  o?.backend === "native" ? openNative(p, o) : openBrowser(p, o);
import { render } from "./src/render.mjs";
import { nativeBinary } from "./src/media.mjs";
import { serve, ENGINE } from "./src/server.mjs";
import { run } from "./src/process.mjs";
const args = process.argv.slice(2),
  command = args.shift(),
  file = args.shift();
function options(args) {
  const o = {};
  const flags = new Set([
    "json",
    "cpu",
    "software-fallback",
    "force",
    "keep-frames",
  ]);
  const values = new Set(
    "size fps from to workers chunk encoder codec bitrate quality backend capture fit ss mb shutter work out audio times pacing port config script max-requests mode".split(
      " ",
    ),
  );
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--"))
      throw Error(`Unexpected argument ${args[i]}`);
    const k = args[i].slice(2);
    if (!flags.has(k) && !values.has(k)) throw Error(`Unknown option --${k}`);
    if (flags.has(k)) o[k] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw Error(`Missing value for --${k}`);
      o[k] = args[++i];
    }
  }
  return o;
}
export async function main() {
  if (!command || command === "help" || command === "--help") {
    console.log(
      "lucent <inspect|preview|render|stills|audio|tts|bench|build> <project.film.json> [--size 1080p|1440p|1200p|4k|WIDTHxHEIGHT] [--codec av1,h265,h264] [--encoder auto|software|vaapi|nvenc|qsv] [--software-fallback] [--from SEC --to SEC] [--backend browser|native] [--keep-frames] [--json]",
    );
    return;
  }
  if (command === "play")
    return run("ffplay", ["-autoexit", file], { timeout: 43200000 });
  const p = project(file),
    o = options(args);
  if (o.pacing) {
    if (!p.pacing?.[o.pacing]) throw Error("Unknown pacing mode");
    p.query = { ...p.query, pacing: o.pacing };
    p.audio = { ...p.audio, file: p.pacing[o.pacing].audio };
  }
  const [width, height] = resolution(o.size || "1080p"),
    fps = frameRate(o.fps || 30);
  const settings = {
    width,
    height,
    fps,
    fpsRational: o.fps || 30,
    from: number(o.from ?? 0, "from", 0, 1e7),
    to: o.to === undefined ? undefined : number(o.to, "to", 0, 1e7),
    workers: number(o.workers ?? 2, "workers", 1, 2),
    chunk:
      o.chunk === undefined ? undefined : number(o.chunk, "chunk", 1, 1800),
    encoder: o.encoder || "auto",
    softwareFallback: !!o["software-fallback"],
    codecs: (o.codec || "av1").split(","),
    bitrate: number(
      o.bitrate ??
        Math.round(
          ((width * height >= 3840 * 2160
            ? 120
            : height >= 1440
              ? 60
              : height >= 1200
                ? 35
                : 30) *
            1e6 *
            fps) /
            30,
        ),
      "bitrate",
      10000,
      1e9,
    ),
    quality:
      o.quality === undefined ? undefined : number(o.quality, "quality", 0, 63),
    backend: o.backend || "browser",
    capture: o.capture || "png",
    fit: o.fit || "fit",
    ss: number(o.ss ?? 1, "ss", 1, 4),
    mb: number(o.mb ?? 1, "mb", 1, 32),
    shutter: number(o.shutter ?? 0.5, "shutter", 0, 1),
    cpu: !!o.cpu,
    keepFrames: !!o["keep-frames"],
    work: o.work ? path.resolve(o.work) : undefined,
    out: o.out ? path.resolve(o.out) : undefined,
    audio: o.audio
      ? path.resolve(o.audio)
      : p.audio?.file && fs.existsSync(path.join(p.root, p.audio.file))
        ? path.join(p.root, p.audio.file)
        : undefined,
    json: !!o.json,
  };
  if (!["png", "rgba"].includes(settings.capture))
    throw Error("capture must be png or experimental rgba");
  for (const k of ["workers", "chunk", "ss", "mb"])
    if (settings[k] !== undefined && !Number.isInteger(settings[k]))
      throw Error(`${k} must be an integer`);
  if (!["fit", "fill", "stretch"].includes(settings.fit))
    throw Error("fit must be fit, fill or stretch");
  if (command === "tts") {
    const { tts } = await import("./src/tts.mjs");
    return console.log(JSON.stringify(await tts(p, o), null, 2));
  }
  if (command === "build") {
    const { bundle } = await import("./src/build.mjs");
    return console.log(await bundle(p, { native: o.backend === "native" }));
  }
  if (command === "preview" && settings.backend === "native") {
    if (p.renderer === "browser-only" || p.adapter !== "scenegraph")
      throw Error("Browser-only films use the browser viewer");
    const { bundle } = await import("./src/build.mjs");
    const bundled = await bundle(p, { native: true });
    return await run(
      nativeBinary(),
      ["native-viewer", bundled, p.manifestFile],
      { timeout: 43200000 },
    );
  }
  if (command === "preview") {
    if (p.adapter === "scenegraph") {
      const { bundle } = await import("./src/build.mjs");
      await bundle(p);
    }
    const service = await serve(p, Number(o.port || 8080));
    console.log(`Preview: ${service.url}`);
    return;
  }
  if (command === "inspect") {
    let film;
    try {
      film = await openFilm(p, { size: [width, height], cpu: settings.cpu });
      const capabilities = {
        browser: {
          available: true,
          features: [
            "groups",
            "transforms",
            "clipping",
            "paths",
            "text",
            "images",
            "cameras",
            "transitions",
            "video",
            "dom",
            "svg",
            "gradients",
            "canvas",
            ...(film.caps.webgl ? ["webgl"] : []),
            ...(film.caps.webgpu ? ["webgpu"] : []),
          ],
        },
        native: await nativeCapabilities(),
      };
      const info = {
        schemaVersion: 1,
        apiVersion: p.apiVersion,
        id: p.id,
        design: p.design,
        renderer: p.renderer,
        duration: film.timeline.total,
        capabilities,
        scenes: film.timeline.scenes.map((s) => ({
          id: s.id,
          start: s.start,
          duration: s.dur,
          renderer: s.renderer || p.renderer,
          requires: s.requires || [],
          dependencies: s.dependencies || [],
          backends: sceneBackends(
            { ...s, renderer: s.renderer || p.renderer },
            capabilities,
          ),
        })),
        media: film.caps,
      };
      console.log(JSON.stringify(info, null, 2));
    } finally {
      if (film) await film.close();
    }
    return;
  }
  if (!["browser", "native"].includes(settings.backend))
    throw Error("backend must be browser or native");
  if (command === "audio") {
    const { audio } = await import("./src/audio.mjs");
    return console.log(await audio(p, settings));
  }
  if (command === "stills") {
    const film = await openFilm(p, { ...settings, size: [width, height] });
    try {
      const out = o.out || path.join(p.root, "out/stills");
      fs.mkdirSync(out, { recursive: true });
      for (const t of (o.times || String(settings.from))
        .split(",")
        .map(Number)) {
        if (!Number.isFinite(t) || t < 0 || t >= film.timeline.total)
          throw Error("Still timestamp outside film");
        const { png } = await film.capture(t, Math.round(t * fps));
        const f = path.join(out, `${t.toFixed(3)}.png`);
        fs.writeFileSync(f, png);
        console.log(f);
      }
    } finally {
      await film.close();
    }
    return;
  }
  if (command === "render" || command === "bench") {
    if (p.renderer === "native-only" && settings.backend === "browser")
      throw Error("native-only project cannot use browser");
    if (command === "bench" && settings.to === undefined)
      settings.to = settings.from + 4;
    const report = await render(p, settings, {
      benchmark: command === "bench",
    });
    console.log(
      o.json
        ? JSON.stringify(report, null, 2)
        : `${report.frameCount} frames: ${report.wallClockSeconds.toFixed(2)}s, ${report.exportFps.toFixed(2)} export FPS, ${report.renderFactorLabel}\n${report.outputs.join("\n")}`,
    );
    return;
  }
  throw Error(`Unknown command: ${command}`);
}
main().catch((e) => {
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
