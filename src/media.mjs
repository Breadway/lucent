import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { run, subprocess, aborter, lease } from "./process.mjs";
import { ENGINE } from "./server.mjs";
import { hash, hashFile, atomicJSON, VERSION } from "./project.mjs";
export const nativeBinary = () =>
  ["release", "debug"]
    .map((mode) => path.join(ENGINE, "target", mode, "lucent"))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ||
  path.join(ENGINE, "target/release/lucent");
export async function probe(file, count = true, timeout = 120000) {
  return JSON.parse(
    await run(
      "ffprobe",
      [
        "-v",
        "error",
        ...(count ? ["-count_frames"] : []),
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ],
      { timeout },
    ),
  ).streams;
}
export async function verify(file, { width, height, frames, fps, codec }) {
  const timeout = Number.isFinite(frames)
    ? Math.min(1800000, 120000 + Math.ceil(frames) * 50)
    : 120000;
  const s = (await probe(file, true, timeout)).find(
    (s) => s.codec_type === "video",
  );
  if (
    !s ||
    s.codec_name !== ({ h265: "hevc" }[codec] || codec) ||
    s.width !== width ||
    s.height !== height ||
    Number(s.nb_read_frames) !== frames ||
    Math.abs(Number(s.duration || frames / fps) - frames / fps) > 1 / fps + 0.01
  )
    throw Error(`Output validation failed: ${file}`);
  if (
    s.color_primaries !== "bt709" ||
    s.color_transfer !== "bt709" ||
    s.color_space !== "bt709" ||
    s.color_range !== "tv"
  )
    throw Error(`Incorrect colour tags: ${file}`);
  if (codec !== "h264" && !/10/.test(s.pix_fmt))
    throw Error("Encoder did not produce 10-bit output");
  return s;
}
export function encoderArgs(codec, encoder, bitrate, quality) {
  const software = { av1: "libsvtav1", h265: "libx265", h264: "libx264" };
  if (!["av1", "h265", "h264"].includes(codec))
    throw Error("Codec must be av1, h265 or h264");
  let name =
    encoder === "software"
      ? software[codec]
      : `${codec === "h265" ? "hevc" : codec}_${encoder}`;
  let options = [];
  if (encoder === "software") {
    options = [
      "-preset",
      codec === "av1" ? "10" : "fast",
      ...(codec === "av1"
        ? ["-svtav1-params", "lp=2"]
        : codec === "h265"
          ? ["-x265-params", "pools=2:frame-threads=1:log-level=error"]
          : []),
    ];
  }
  if (quality !== undefined) {
    if (encoder === "software") options.push("-crf", String(quality));
    else if (encoder === "vaapi")
      options.push("-rc_mode", "CQP", "-qp", String(quality));
    else options.push("-cq", String(quality));
  } else
    options.push(
      "-b:v",
      String(bitrate),
      ...(codec === "av1" && encoder === "software"
        ? []
        : ["-maxrate", String(bitrate * 1.5), "-bufsize", String(bitrate * 2)]),
    );
  return ["-c:v", name, ...options, "-threads", "2"];
}
export function colorFilter(codec, encoder) {
  const fmt = codec === "h264" ? "yuv420p" : "yuv420p10le";
  return `format=gbrp16le,zscale=primariesin=709:transferin=iec61966-2-1:matrixin=gbr:rangein=full:primaries=709:transfer=709:matrix=709:range=limited:dither=error_diffusion,format=${fmt}${encoder === "vaapi" ? `,format=${codec === "h264" ? "nv12" : "p010le"},hwupload` : ""}`;
}
export function encodingOptions(codec, encoder, settings) {
  return [
    ...(encoder === "vaapi"
      ? ["-vaapi_device", settings.device || "/dev/dri/renderD128"]
      : []),
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    "-threads",
    "2",
  ];
}
export async function checkEncoder(codec, encoder, settings) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "film-probe-")),
    file = path.join(scratch, "probe.mp4");
  try {
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        ...encodingOptions(codec, encoder, settings),
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${settings.width}x${settings.height}:r=${settings.fps}`,
        "-frames:v",
        "3",
        "-vf",
        colorFilter(codec, encoder),
        ...encoderArgs(codec, encoder, settings.bitrate, settings.quality),
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        file,
      ],
      { timeout: 120000 },
    );
    await verify(file, { ...settings, frames: 3, codec });
    return {
      codec,
      encoder,
      available: true,
      hardware: encoder !== "software",
      bitDepth: codec === "h264" ? 8 : 10,
    };
  } catch (e) {
    return { codec, encoder, available: false, reason: e.message };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
export async function selectEncoder(codec, settings) {
  const requested = settings.encoder || "auto",
    candidates =
      requested === "auto"
        ? fs.existsSync("/dev/dri")
          ? ["vaapi", "nvenc", "qsv"]
          : ["nvenc", "qsv"]
        : [requested];
  const failures = [];
  for (const e of candidates) {
    const test = await checkEncoder(codec, e, settings);
    if (test.available) return test;
    failures.push(test);
  }
  if (requested === "software" || settings.softwareFallback) {
    const test = await checkEncoder(codec, "software", settings);
    if (test.available) return { ...test, failures };
    failures.push(test);
  }
  throw Error(
    `No usable ${codec} encoder. ${failures.map((f) => `${f.encoder}: ${f.reason}`).join("\n")}\nChoose --encoder software or --software-fallback.`,
  );
}
export async function encodeImages(images, file, codec, encoder, settings) {
  const temp = file + ".part.mp4";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let ff, normalizer;
  const release = lease(
    path.join(os.homedir(), ".cache/lucent/leases"),
    encoder === "software" ? "cpu-encoder" : "gpu-encoder",
    2,
  );
  try {
    ff = subprocess(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        ...encodingOptions(codec, encoder, settings),
        "-f",
        "image2pipe",
        "-framerate",
        String(settings.fpsRational || settings.fps),
        "-c:v",
        "ppm",
        "-i",
        "-",
        "-vf",
        colorFilter(codec, encoder),
        ...encoderArgs(codec, encoder, settings.bitrate, settings.quality),
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-movflags",
        "+faststart",
        temp,
      ],
      { pipe: true, timeout: 1800000 },
    );
    normalizer = subprocess(nativeBinary(), ["frame-stream"], {
      pipe: true,
      stdoutSink: ff.child.stdin,
      timeout: 1800000,
    });
    for (const image of images) {
      aborter.signal.throwIfAborted();
      const bytes = fs.readFileSync(image),
        length = Buffer.alloc(4);
      length.writeUInt32LE(bytes.length);
      await normalizer.write(length);
      await normalizer.write(bytes);
    }
    normalizer.child.stdin.end();
    await normalizer.done;
    await ff.done;
    await verify(temp, { ...settings, frames: images.length, codec });
    fs.renameSync(temp, file);
    return { checksum: hashFile(file), codec, encoder };
  } finally {
    normalizer?.child.kill("SIGTERM");
    ff?.child.kill("SIGTERM");
    fs.rmSync(temp, { force: true });
    release();
  }
}
export async function concatChunks(
  files,
  out,
  settings,
  codec,
  audio,
  from = 0,
) {
  const list = out + ".list.part",
    temp = out + ".part.mp4";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    list,
    files
      .map((f) => `file '${path.resolve(f).replaceAll("'", "'\\''")}'`)
      .join("\n"),
  );
  try {
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        ...(audio ? ["-ss", String(from), "-i", audio] : []),
        "-map",
        "0:v:0",
        ...(audio ? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "320k"] : []),
        "-c:v",
        "copy",
        "-t",
        String(settings.frames / settings.fps),
        "-movflags",
        "+faststart",
        temp,
      ],
      { timeout: 1800000 },
    );
    await verify(temp, { ...settings, codec });
    fs.renameSync(temp, out);
  } finally {
    fs.rmSync(temp, { force: true });
    fs.rmSync(list, { force: true });
  }
}
export async function masteredAudio(file, cacheRoot, target = -16.5) {
  const key = hash({
      source: hashFile(file),
      masteringVersion: 1,
      target,
    }),
    out = path.join(cacheRoot, `master-${key}.wav`),
    record = out + ".json";
  try {
    const meta = JSON.parse(fs.readFileSync(record));
    if (meta.checksum === hashFile(out)) return out;
  } catch {}
  const compression =
    "acompressor=threshold=0.063:ratio=2.2:attack=25:release=400:makeup=1";
  const measurement = subprocess(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      compression + ",ebur128=peak=true",
      "-f",
      "null",
      "-",
    ],
    { timeout: 1800000 },
  );
  await measurement.done;
  const matches = [
      ...measurement.stderr().matchAll(/I:\s+(-?\d+(?:\.\d+)?|-inf)\s+LUFS/g),
    ],
    integrated = Number(matches.at(-1)?.[1]),
    gain = Number.isFinite(integrated) ? target - integrated : 0,
    temp = out + ".part.wav";
  try {
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        file,
        "-af",
        `${compression},volume=${gain}dB,alimiter=limit=0.84:attack=5:release=80:level=disabled`,
        "-ar",
        "48000",
        "-ac",
        "2",
        temp,
      ],
      { timeout: 1800000 },
    );
    const streams = await probe(temp, false);
    if (!streams.some((s) => s.codec_type === "audio" && s.duration > 0))
      throw Error("Invalid mastered audio");
    fs.renameSync(temp, out);
    atomicJSON(record, {
      schemaVersion: 1,
      checksum: hashFile(out),
      target,
      measuredIntegrated: integrated,
      gainDb: gain,
    });
    return out;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
