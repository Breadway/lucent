import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
import { memoryMonitor } from "./memory.mjs";
import { mixAudio } from "./mix.mjs";
import { openFilm as openBrowser } from "./browser.mjs";
import { openNative } from "./native.mjs";
const openFilm = (p, s) =>
  s.backend === "native" ? openNative(p, s) : openBrowser(p, s);
import {
  atomicJSON,
  cacheKey,
  hash,
  hashFile,
  sourceFingerprint,
  frameTime,
  VERSION,
  inside,
} from "./project.mjs";
import {
  encodeImages,
  selectEncoder,
  concatChunks,
  probe,
  verify,
  masteredAudio,
} from "./media.mjs";
import { aborter, lease, run } from "./process.mjs";
function validFrame(file, checksum, width, height) {
  try {
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== checksum) return false;
    // The checksum proves the bytes are the ones we wrote; only the dimensions need
    // checking, and they sit in the IHDR chunk, so there is no need to decode pixels.
    return (
      bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(PNG_SIGNATURE) &&
      bytes.toString("latin1", 12, 16) === "IHDR" &&
      bytes.readUInt32BE(16) === width &&
      bytes.readUInt32BE(20) === height
    );
  } catch {
    return false;
  }
}
function quarantine(file, root, kind) {
  const dir = path.join(root, "quarantine");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${path.basename(file)}.${kind}.${Date.now()}.${process.pid}.corrupt`;
  try {
    fs.renameSync(file, path.join(dir, name));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
export function pruneChunkFrames(dir, a, b) {
  for (let f = a; f < b; f++)
    fs.rmSync(path.join(dir, `${f}.png`), { force: true });
}
const DEFAULT_MAX_SEGMENT = 120;
export function planChunks(first, last, chunk, workers = 1) {
  const total = last - first;
  if (!(total > 0)) return [];
  if (chunk !== undefined) {
    const out = [];
    for (let a = first; a < last; a += chunk)
      out.push({ a, b: Math.min(last, a + chunk) });
    return out;
  }
  const count = Math.min(
    total,
    Math.max(workers, Math.ceil(total / DEFAULT_MAX_SEGMENT)),
  );
  const base = Math.floor(total / count),
    extra = total % count,
    out = [];
  let a = first;
  for (let i = 0; i < count; i++) {
    const b = a + base + (i < extra ? 1 : 0);
    out.push({ a, b });
    a = b;
  }
  return out;
}
export async function restoreChunk({
  dir,
  a,
  b,
  key,
  codecs,
  settings,
  verify: verifySegment = verify,
}) {
  const outputs = {};
  for (const codec of codecs) {
    const file = path.join(dir, `${codec}.mp4`),
      record = file + ".json";
    let old;
    try {
      old = JSON.parse(fs.readFileSync(record));
    } catch {
      return null;
    }
    if (old.key !== key) return null;
    try {
      if (old.checksum !== hashFile(file)) return null;
    } catch {
      return null;
    }
    try {
      await verifySegment(file, { ...settings, frames: b - a, codec });
    } catch {
      return null;
    }
    outputs[codec] = file;
  }
  return outputs;
}

export async function render(p, settings, { benchmark = false } = {}) {
  const stopMemory = memoryMonitor();
  const start = performance.now(),
    metrics = {
      rawCopyMs: 0,
      rawTransferMs: 0,
      drawingMs: 0,
      seekMs: 0,
      captureMs: 0,
      transportMs: 0,
      conversionEncodeMs: 0,
      framesCaptured: 0,
      framesReused: 0,
    };
  const root = settings.work || path.join(os.homedir(), ".cache/lucent", p.id);
  fs.mkdirSync(root, { recursive: true });
  let release, initial;
  const chunkIntervals = [];
  try {
    release = lease(root, "job", 1);
    const initialStarted = performance.now();
    initial = await openFilm(p, {
      ...settings,
      size: [settings.width, settings.height],
    });
    const total = initial.timeline.total,
      first = Math.round(settings.from * settings.fps),
      last = Math.min(
        Math.ceil(total * settings.fps),
        Math.round((settings.to ?? total) * settings.fps),
      );
    if (last <= first) throw Error("Export range has no frames");
    const initialLoadMs = performance.now() - initialStarted;
    const browserVersion = await initial.browser.version(),
      environment = {
        browserVersion,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        ffmpeg: (await run("ffmpeg", ["-version"])).toString().split("\n")[0],
        acceleration: initial.caps,
      };
    const timeline = initial.timeline;
    await initial.close();
    initial = null;
    for (const scene of timeline.scenes)
      for (const dependency of scene.dependencies || [])
        inside(
          p.root,
          typeof dependency === "string" ? dependency : dependency.path,
        );
    const scenes = timeline.scenes.map((s) => s.id),
      fingerprint = sourceFingerprint(p),
      baseSettings = {
        ...settings,
        work: undefined,
        out: undefined,
        keepFrames: undefined,
        browserVersion,
        graphics: environment.acceleration,
        ffmpeg: environment.ffmpeg,
        engine: VERSION,
      };
    const key = cacheKey(p, baseSettings, fingerprint),
      cache = path.join(root, key);
    fs.mkdirSync(cache, { recursive: true });
    const report = {
      schemaVersion: 1,
      engine: VERSION,
      backend: settings.backend || "browser",
      project: p.id,
      capture: settings.capture || "png",
      experimental:
        settings.capture === "rgba" || settings.backend === "native",
      promoted: false,
      scenes,
      environment,
      resolution: [settings.width, settings.height],
      fps: settings.fps,
      frameCount: last - first,
      range: [first, last],
      hardwareAcceleration: {
        encoding: false,
        graphics: environment.acceleration.renderer,
        graphicsActive: environment.acceleration.renderer
          ? !/swiftshader|llvmpipe|software/i.test(
              environment.acceleration.renderer,
            )
          : null,
      },
      settings: baseSettings,
    };
    atomicJSON(path.join(root, "status.json"), {
      state: "running",
      key,
      range: [first, last],
      started: new Date().toISOString(),
    });
    const probeStart = performance.now();
    const codecs = settings.codecs,
      encoders = {};
    for (const codec of codecs)
      encoders[codec] = await selectEncoder(codec, settings);
    report.hardwareAcceleration.encoding = Object.values(encoders).some(
      (e) => e.hardware,
    );
    report.encoders = encoders;
    report.initialLoadMs = initialLoadMs;
    const chunks = planChunks(first, last, settings.chunk, settings.workers);
    report.chunkPlan = chunks.map((c) => c.b - c.a);
    let next = 0,
      completed = 0;
    report.encoderProbeMs = performance.now() - probeStart;
    const chunkResults = [];
    async function worker() {
      let film;
      const slot = lease(
        path.join(os.homedir(), ".cache/lucent/leases"),
        "graphics",
        2,
      );
      try {
        film = await openFilm(p, {
          ...settings,
          size: [settings.width, settings.height],
        });
        while (next < chunks.length) {
          aborter.signal.throwIfAborted();
          const index = next++,
            chunkStarted = performance.now(),
            { a, b } = chunks[index],
            active = timeline.scenes.filter(
              (s) =>
                s.start + s.dur + Number(s.preroll || 0) >= a / settings.fps &&
                s.start - Number(s.transition || s.trans || 0) <=
                  b / settings.fps,
            ),
            chunkKey =
              p.adapter === "scenegraph"
                ? hash({
                    key,
                    a,
                    b,
                    scenes: active.map((s) => ({
                      id: s.id,
                      implementation: s.implementation,
                      dependencies: (s.dependencies || []).map((d) => ({
                        declaration: d,
                        hash: sourceFingerprint({
                          ...p,
                          adapter: "scenegraph",
                          dependencies: [d],
                        }),
                      })),
                    })),
                  })
                : key,
            dir = path.join(cache, `${a}-${b}`);
          const chunkRecord = path.join(dir, "chunk-key.json");
          if (fs.existsSync(chunkRecord)) {
            let previous;
            try {
              previous = JSON.parse(fs.readFileSync(chunkRecord)).key;
            } catch {
              previous = null;
            }
            if (previous !== chunkKey) quarantine(dir, cache, "chunk");
          }
          fs.mkdirSync(dir, { recursive: true });
          atomicJSON(chunkRecord, { key: chunkKey });
          const manifestFile = path.join(dir, "frames.json");
          let entries = [];
          if (fs.existsSync(manifestFile)) {
            try {
              entries = JSON.parse(fs.readFileSync(manifestFile)).frames;
              if (!Array.isArray(entries))
                throw Error("Invalid frame manifest");
            } catch {
              quarantine(manifestFile, dir, "manifest");
              entries = [];
            }
          }
          if (!benchmark) {
            const restored = await restoreChunk({
              dir,
              a,
              b,
              key,
              codecs,
              settings,
            });
            if (restored) {
              chunkResults[index] = restored;
              chunkIntervals.push([chunkStarted, performance.now()]);
              completed += b - a;
              atomicJSON(path.join(root, "status.json"), {
                state: "running",
                key,
                done: completed,
                total: last - first,
              });
              if (!settings.json)
                console.error(`${completed}/${last - first} frames verified`);
              continue;
            }
          }
          const stat = fs.statfsSync(dir);
          if (
            stat.bavail * stat.bsize <
            (b - a) * settings.width * settings.height
          )
            throw Error("Insufficient disk space for frame cache");
          let repaired = false;
          for (let f = a; f < b; f++) {
            const file = path.join(dir, `${f}.png`),
              old = entries[f - a];
            if (
              !benchmark &&
              old &&
              validFrame(file, old.hash, settings.width, settings.height)
            ) {
              metrics.framesReused++;
              continue;
            }
            repaired = true;
            if (fs.existsSync(file)) quarantine(file, dir, "frame");
            const captured = await film.capture(
              frameTime(f, settings.fpsRational || settings.fps),
              f,
            );
            metrics.drawingMs += captured.drawMs;
            metrics.seekMs += captured.seekMs;
            metrics.captureMs += captured.captureMs;
            metrics.rawCopyMs += captured.rawCopyMs || 0;
            metrics.rawTransferMs += captured.rawTransferMs || 0;
            const writeStart = performance.now();
            const temp = file + ".part";
            fs.writeFileSync(temp, captured.png);
            fs.renameSync(temp, file);
            metrics.transportMs += performance.now() - writeStart;
            entries[f - a] = { frame: f, hash: hash(captured.png) };
            metrics.framesCaptured++;
            atomicJSON(manifestFile, {
              schemaVersion: 1,
              key,
              width: settings.width,
              height: settings.height,
              frames: entries,
            });
          }
          const images = Array.from({ length: b - a }, (_, i) =>
              path.join(dir, `${a + i}.png`),
            ),
            outputs = {};
          for (const codec of codecs) {
            const file = path.join(dir, `${codec}.mp4`),
              record = file + ".json";
            let reused = false;
            try {
              const old = JSON.parse(fs.readFileSync(record));
              if (
                !benchmark &&
                !repaired &&
                old.key === key &&
                old.checksum === hashFile(file)
              ) {
                await verify(file, { ...settings, frames: b - a, codec });
                reused = true;
              }
            } catch {
              if (fs.existsSync(file)) quarantine(file, dir, "encode");
              if (fs.existsSync(record)) quarantine(record, dir, "record");
            }
            if (!reused) {
              const t = performance.now();
              const encoded = await encodeImages(
                images,
                file,
                codec,
                encoders[codec].encoder,
                settings,
              );
              metrics.conversionEncodeMs += performance.now() - t;
              atomicJSON(record, { schemaVersion: 1, key, ...encoded });
            }
            outputs[codec] = file;
          }
          if (!settings.keepFrames) pruneChunkFrames(dir, a, b);
          chunkResults[index] = outputs;
          chunkIntervals.push([chunkStarted, performance.now()]);
          completed += b - a;
          atomicJSON(path.join(root, "status.json"), {
            state: "running",
            key,
            done: completed,
            total: last - first,
          });
          if (!settings.json)
            console.error(`${completed}/${last - first} frames verified`);
        }
      } finally {
        if (film) await film.close();
        slot();
      }
    }
    const jobs = Array.from(
      { length: Math.min(settings.workers, chunks.length) },
      worker,
    );
    try {
      await Promise.all(jobs);
    } catch (e) {
      aborter.abort(e);
      await Promise.allSettled(jobs);
      throw e;
    }
    const flushStart = performance.now();
    const mixed = await mixAudio(p, timeline, { score: settings.audio });
    const audioSource = mixed ? await masteredAudio(mixed, cache) : undefined;
    const outputs = [];
    for (const codec of codecs) {
      const out = settings.out
        ? settings.out.replace(
            /\.mp4$/,
            codecs.length > 1 ? `-${codec}.mp4` : ".mp4",
          )
        : path.join(
            os.homedir(),
            "Videos/Breadway Films",
            `${p.id}-${codec}.mp4`,
          );
      await concatChunks(
        chunkResults.map((c) => c[codec]),
        out,
        { ...settings, frames: last - first },
        codec,
        audioSource,
        first / settings.fps,
      );
      outputs.push(out);
    }
    report.flushAndMuxMs = performance.now() - flushStart;
    const wall = (performance.now() - start) / 1000,
      media = (last - first) / settings.fps;
    const steadyStart = chunkIntervals.length
      ? Math.min(...chunkIntervals.map((x) => x[0]))
      : performance.now();
    const steadyEnd = chunkIntervals.length
      ? Math.max(...chunkIntervals.map((x) => x[1]))
      : steadyStart;
    const steadySeconds = (steadyEnd - steadyStart) / 1000;
    Object.assign(report, {
      metrics,
      outputs,
      wallClockSeconds: wall,
      exportFps: (last - first) / wall,
      steadyStateSeconds: steadySeconds,
      steadyStateFps: steadySeconds > 0 ? (last - first) / steadySeconds : 0,
      renderFactor: wall / media,
      renderFactorLabel: `${(wall / media).toFixed(2)}x realtime`,
      memory: stopMemory(),
    });
    atomicJSON(path.join(root, "benchmark.json"), report);
    atomicJSON(path.join(root, "status.json"), {
      state: "complete",
      outputs,
      key,
    });
    return report;
  } catch (e) {
    atomicJSON(path.join(root, "status.json"), {
      state: aborter.signal.aborted ? "cancelled" : "failed",
      error: e.message,
    });
    throw e;
  } finally {
    stopMemory();
    if (initial) await initial.close();
    release?.();
  }
}
