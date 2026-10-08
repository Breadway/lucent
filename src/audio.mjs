import fs from "node:fs";
import path from "node:path";
import { openFilm } from "./browser.mjs";
import { ENGINE } from "./server.mjs";
import { atomicJSON } from "./project.mjs";
import { run, aborter } from "./process.mjs";
import { mixAudio } from "./mix.mjs";
import { extension } from "./extensions.mjs";
export async function audio(p, settings) {
  const film = await openFilm(p, { size: [640, 360], cpu: settings.cpu });
  const out = path.join(p.root, "out", `${p.id}-score.wav`);
  const finish = (score) =>
    mixAudio(p, film.timeline, {
      score,
      out: settings.out || path.join(p.root, "out", `${p.id}-audio.wav`),
    });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    if (p.audio?.provider === "existing") {
      return finish(path.resolve(p.root, p.audio.file));
    }
    if (p.adapter === "astra") {
      const timeline = path.join(
        p.root,
        "out",
        p.id === "edu" ? "edu" : "",
        "timeline.json",
      );
      atomicJSON(timeline, film.timeline);
      await run(
        process.env.PYTHON ||
          (fs.existsSync(path.join(ENGINE, ".venv/bin/python"))
            ? path.join(ENGINE, ".venv/bin/python")
            : "python3"),
        [
          "-c",
          `import sys,json;sys.path.insert(0,sys.argv[1]);from music_stream import write_score;write_score(json.load(open(sys.argv[2])),sys.argv[3],sys.argv[4])`,
          path.join(ENGINE, "compat/astra"),
          timeline,
          p.id,
          out,
        ],
        { timeout: 1800000 },
      );
      return finish(out);
    }
    if (p.adapter !== "breadway") {
      if (p.audio?.provider && p.audio.provider !== "none") {
        const provider = await extension(p, "audio", p.audio.provider);
        const result = await provider.render({
          project: p,
          timeline: film.timeline,
          out,
          signal: aborter.signal,
        });
        return finish(result);
      }
      return finish(undefined);
    }
    const raw = out + ".part.raw",
      temp = out + ".part.wav",
      fd = fs.openSync(raw, "w"),
      sampleRate = 48000,
      chunk = 60,
      overlap = 0.4;
    let previous = null;
    try {
      for (let from = 0; from < film.timeline.total + 0.5; from += chunk) {
        aborter.signal.throwIfAborted();
        const to = Math.min(film.timeline.total + 0.5, from + chunk);
        await film.page.evaluate(
          async (from, to) => {
            window.__pcm = await (
              FILMDATA.audio === "bos" ? renderAudioBOS : renderAudio3
            )({ from: Math.max(0, from - 0.4), to: to + 0.4, pre: 22 });
          },
          from,
          to,
        );
        const bytes = await film.page.evaluate(() => {
          const u = new Uint8Array(
            __pcm.buffer,
            __pcm.byteOffset,
            __pcm.byteLength,
          );
          let s = "";
          for (let i = 0; i < u.length; i += 32768)
            s += String.fromCharCode(...u.subarray(i, i + 32768));
          return btoa(s);
        });
        const buf = Buffer.from(bytes, "base64"),
          pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2),
          ov = Math.round(overlap * sampleRate) * 2;
        let start = from ? ov : 0,
          end = start + Math.round((to - from) * sampleRate) * 2;
        if (previous) {
          for (let i = 0; i < ov * 2; i++) {
            const w = i / (ov * 2);
            pcm[i] = Math.round(previous[i] * (1 - w) + pcm[i] * w);
          }
          fs.writeSync(fd, Buffer.from(pcm.buffer, pcm.byteOffset, ov * 2 * 2));
          start = ov * 2;
        }
        if (to < film.timeline.total + 0.5) {
          end -= ov;
          previous = pcm.slice(end, end + ov * 2);
        } else previous = null;
        if (end > start)
          fs.writeSync(
            fd,
            Buffer.from(
              pcm.buffer,
              pcm.byteOffset + start * 2,
              (end - start) * 2,
            ),
          );
      }
    } finally {
      fs.closeSync(fd);
    }
    try {
      await run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "s16le",
        "-ar",
        String(sampleRate),
        "-ac",
        "2",
        "-i",
        raw,
        temp,
      ]);
      fs.renameSync(temp, out);
    } finally {
      fs.rmSync(raw, { force: true });
      fs.rmSync(temp, { force: true });
    }
    return finish(out);
  } finally {
    await film.close();
  }
}
