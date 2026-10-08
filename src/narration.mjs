import fs from "node:fs";
import path from "node:path";
import { atomicJSON, hash, hashFile, inside } from "./project.mjs";
import { probe } from "./media.mjs";
import { run, aborter } from "./process.mjs";

export function validateScript(p, script) {
  if (
    script.schemaVersion !== 1 ||
    script.film !== p.id ||
    !Array.isArray(script.cues)
  )
    throw Error("Narration script must use schema 1 and match the film ID");
  const ids = new Set();
  for (const c of script.cues) {
    if (
      !c.id ||
      ids.has(c.id) ||
      typeof c.scene !== "string" ||
      !Number.isFinite(c.time) ||
      c.time < 0 ||
      typeof c.text !== "string" ||
      !c.text.trim()
    )
      throw Error(
        "Narration cues require unique IDs, scene, nonnegative timestamp and text",
      );
    ids.add(c.id);
  }
  return script;
}

export async function assembleNarration(
  p,
  timeline,
  script,
  generated,
  {
    mode = p.narration?.mode || "overlay",
    out = path.join(p.root, "out/tts"),
  } = {},
) {
  if (!["overlay", "extend"].includes(mode))
    throw Error("Narration mode must be overlay or extend");
  validateScript(p, script);
  if (mode === "extend" && p.adapter !== "scenegraph")
    throw Error(
      "Automatic extension uses portable scenes; legacy films retain their existing retiming adapters",
    );
  const cues = [];
  for (const cue of script.cues) {
    const recording = generated.cues.find((c) => (c.cue || c.id) === cue.id);
    if (!recording?.file)
      throw Error(
        `Narration cue ${cue.id} is not generated; resume TTS before assembling`,
      );
    const file = inside(p.root, path.relative(p.root, recording.file));
    const stream = (await probe(file, false)).find(
      (s) => s.codec_type === "audio",
    );
    const duration = Number(stream?.duration);
    if (!(duration > 0)) throw Error(`Invalid narration recording ${cue.id}`);
    cues.push({
      id: cue.id,
      scene: cue.scene,
      time: cue.time,
      text: cue.text,
      duration,
      file,
      checksum: hashFile(file),
      alignment: "cue-start exact; word timing unavailable",
    });
  }
  const scenes = [],
    overrides = [];
  let shift = 0;
  for (const scene of timeline.scenes) {
    const own = cues
      .filter((c) => c.scene === scene.id)
      .sort((a, b) => a.time - b.time);
    const originalDuration = scene.dur ?? scene.duration;
    let end = 0;
    for (const cue of own) {
      if (cue.time < end - 0.001 && !script.allowOverlap)
        throw Error(
          `Overlapping narration at ${cue.id}; adjust cue timestamps or explicitly allowOverlap`,
        );
      end = Math.max(end, cue.time + cue.duration);
    }
    if (end > originalDuration + 0.01 && mode === "overlay")
      throw Error(
        `Narration extends ${scene.id} by ${(end - originalDuration).toFixed(2)}s; edit timing or choose extend mode`,
      );
    const dur = Math.max(
      originalDuration,
      end +
        (mode === "extend" && end > originalDuration
          ? Number(p.narration?.tail ?? 0.25)
          : 0),
    );
    const start = scene.start + shift;
    for (const cue of own) cue.start = start + cue.time;
    scenes.push({
      id: scene.id,
      start,
      dur,
      originalDuration,
      caps: own.map((c) => [c.time, c.text]),
    });
    overrides.push({
      id: scene.id,
      start,
      duration: dur,
      originalDuration,
      caps: own.map((c) => [c.time, c.text]),
    });
    shift += dur - originalDuration;
  }
  for (const cue of cues)
    if (!scenes.some((s) => s.id === cue.scene))
      throw Error(`Unknown narration scene ${cue.scene}`);
  const total = timeline.total + shift;
  const key = hash({ schemaVersion: 1, mode, total, cues, overrides });
  fs.mkdirSync(out, { recursive: true });
  const final = path.join(out, "narration.wav"),
    temp = path.join(out, `${process.pid}.part.wav`);
  const raw = path.join(out, `${process.pid}.part.f32`),
    fd = fs.openSync(raw, "w+");
  const rate = 48000,
    frames = Math.ceil(total * rate);
  const temps = [];
  try {
    // Sparse destination plus bounded blocks avoids allocating a whole-film PCM array.
    fs.ftruncateSync(fd, frames * 4);
    for (const cue of cues) {
      aborter.signal.throwIfAborted();
      const pcm = path.join(
        out,
        `${cue.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.${process.pid}.part.pcm`,
      );
      temps.push(pcm);
      await run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-i",
        cue.file,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(rate),
        "-f",
        "f32le",
        pcm,
      ]);
      const input = fs.openSync(pcm, "r");
      try {
        const block = Buffer.alloc(65536),
          prior = Buffer.alloc(65536);
        let offset = Math.round(cue.start * rate) * 4,
          position = 0;
        while (position < fs.statSync(pcm).size && offset < frames * 4) {
          const n = fs.readSync(
            input,
            block,
            0,
            Math.min(block.length, frames * 4 - offset),
            position,
          );
          if (!n) break;
          prior.fill(0);
          fs.readSync(fd, prior, 0, n, offset);
          for (let i = 0; i < n; i += 4)
            prior.writeFloatLE(prior.readFloatLE(i) + block.readFloatLE(i), i);
          fs.writeSync(fd, prior, 0, n, offset);
          offset += n;
          position += n;
        }
      } finally {
        fs.closeSync(input);
      }
    }
    fs.closeSync(fd);
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "f32le",
      "-ar",
      String(rate),
      "-ac",
      "1",
      "-i",
      raw,
      "-af",
      "alimiter=limit=0.95:level=false:latency=true",
      "-c:a",
      "pcm_s24le",
      temp,
    ]);
    const audio = (await probe(temp, false)).find(
      (s) => s.codec_type === "audio",
    );
    if (Math.abs(Number(audio?.duration) - total) > 1 / rate + 0.001)
      throw Error("Narration assembly duration mismatch");
    fs.renameSync(temp, final);
    const result = {
      schemaVersion: 1,
      apiVersion: "0.1.0",
      film: p.id,
      key,
      scriptHash: hash(script),
      mode,
      total,
      file: path.relative(p.root, final),
      overrides,
      cues: cues.map((c) => ({ ...c, file: path.relative(p.root, c.file) })),
    };
    atomicJSON(path.join(out, "timeline.json"), result);
    return result;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    for (const file of [...temps, raw, temp]) fs.rmSync(file, { force: true });
  }
}

export function narrationTiming(p) {
  if (p.narration?.disabled) return undefined;
  const file = p.narration?.timeline || "out/tts/timeline.json";
  if (!fs.existsSync(path.join(p.root, file))) {
    if (p.narration?.timeline)
      throw Error("Declared narration timeline is missing");
    return undefined;
  }
  const timing = JSON.parse(fs.readFileSync(inside(p.root, file)));
  if (
    timing.schemaVersion !== 1 ||
    timing.apiVersion !== "0.1.0" ||
    timing.film !== p.id
  )
    throw Error("Incompatible narration timeline");
  const script = p.narration?.script || "narration.script.json";
  if (
    fs.existsSync(path.join(p.root, script)) &&
    hash(JSON.parse(fs.readFileSync(inside(p.root, script)))) !==
      timing.scriptHash
  )
    throw Error(
      "Narration script changed; regenerate or reassemble narration before rendering",
    );
  for (const cue of timing.cues)
    if (hashFile(inside(p.root, cue.file)) !== cue.checksum)
      throw Error(
        `Narration recording changed: ${cue.id}; reassemble before rendering`,
      );
  return timing;
}
