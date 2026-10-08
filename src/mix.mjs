import fs from "node:fs";
import path from "node:path";
import { hash, hashFile, atomicJSON, inside } from "./project.mjs";
import { narrationTiming } from "./narration.mjs";
import { probe } from "./media.mjs";
import { run } from "./process.mjs";

function tempo(rate) {
  const factors = [];
  while (rate > 2) {
    factors.push(2);
    rate /= 2;
  }
  while (rate < 0.5) {
    factors.push(0.5);
    rate *= 2;
  }
  factors.push(rate);
  return factors.map((n) => `atempo=${n}`).join(",");
}
export async function mixAudio(p, timeline, { score, out } = {}) {
  const timing = narrationTiming(p),
    tracks = p.audio?.tracks || [];
  if (!timing && !tracks.length) return score;
  const inputs = [],
    filters = [],
    labels = [];
  function input(file, external = false) {
    inputs.push(
      external
        ? fs.realpathSync(file)
        : inside(p.root, path.relative(p.root, file)),
    );
    return inputs.length - 1;
  }
  let scoreIndex, narrationIndex;
  if (score) scoreIndex = input(score, true);
  if (timing) narrationIndex = input(path.join(p.root, timing.file));
  for (const [i, track] of tracks.entries()) {
    const scene = track.scene
      ? timeline.scenes.find((s) => s.id === track.scene)
      : undefined;
    if (track.scene && !scene)
      throw Error(`Unknown audio track scene ${track.scene}`);
    const start = (scene?.start || 0) + Number(track.time || 0),
      rate = Number(track.rate || 1),
      trim = Number(track.trim || 0),
      duration = Number(track.duration ?? scene?.dur ?? timeline.total);
    if (
      ![start, rate, trim, duration, Number(track.gain ?? 1)].every(
        Number.isFinite,
      ) ||
      start < 0 ||
      rate <= 0 ||
      rate > 16 ||
      trim < 0 ||
      duration <= 0
    )
      throw Error(`Invalid audio track ${i}`);
    const index = input(path.resolve(p.root, track.src));
    const stream = (await probe(inputs[index], false)).find(
      (s) => s.codec_type === "audio",
    );
    if (!stream) throw Error(`Clip has no source audio: ${track.src}`);
    let chain = `[${index}:a]atrim=start=${trim}${track.sourceDuration ? `:duration=${Number(track.sourceDuration)}` : ""},asetpts=PTS-STARTPTS,aresample=48000`;
    if (track.loop) {
      const d = Number(track.sourceDuration);
      if (!(d > 0)) throw Error("Looped audio requires sourceDuration");
      chain += `,aloop=loop=-1:size=${Math.round(d * 48000)}`;
    }
    chain += `,${tempo(rate)},atrim=duration=${duration},volume=${Number(track.gain ?? 1)},adelay=${Math.round(start * 48000)}S:all=1[track${i}]`;
    filters.push(chain);
    labels.push(`[track${i}]`);
  }
  if (narrationIndex !== undefined && scoreIndex !== undefined) {
    filters.push(
      `[${narrationIndex}:a]aresample=48000,asplit=2[voice][duck]`,
      `[${scoreIndex}:a]aresample=48000[music]`,
      `[music][duck]sidechaincompress=threshold=0.02:ratio=6:attack=15:release=300[bed]`,
    );
    labels.unshift("[bed]", "[voice]");
  } else if (narrationIndex !== undefined)
    labels.unshift(`[${narrationIndex}:a]`);
  else if (scoreIndex !== undefined) labels.unshift(`[${scoreIndex}:a]`);
  filters.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,apad,atrim=duration=${timeline.total},alimiter=limit=0.95:level=false:latency=true[mix]`,
  );
  out = out || path.join(p.root, "out", `${p.id}-audio.wav`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const key = hash({
    version: 1,
    inputs: inputs.map((file) => [file, hashFile(file)]),
    filters,
  });
  const record = out + ".json";
  try {
    const old = JSON.parse(fs.readFileSync(record));
    if (
      old.key === key &&
      old.checksum === hashFile(out) &&
      Math.abs(
        Number((await probe(out, false))[0]?.duration) - timeline.total,
      ) < 0.01
    )
      return out;
  } catch {}
  const temp = out + `.${process.pid}.part.wav`;
  try {
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-filter_complex_threads",
        "1",
        ...inputs.flatMap((file) => ["-i", file]),
        "-filter_complex",
        filters.join(";"),
        "-map",
        "[mix]",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-c:a",
        "pcm_s24le",
        temp,
      ],
      { timeout: 1800000 },
    );
    if (
      Math.abs(
        Number(
          (await probe(temp, false)).find((s) => s.codec_type === "audio")
            ?.duration,
        ) - timeline.total,
      ) > 0.01
    )
      throw Error("Mixed audio duration mismatch");
    fs.renameSync(temp, out);
    atomicJSON(record, {
      schemaVersion: 1,
      key,
      checksum: hashFile(out),
    });
    return out;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
