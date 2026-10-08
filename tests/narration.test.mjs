import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/process.mjs";
import { project } from "../src/project.mjs";
import { assembleNarration } from "../src/narration.mjs";
import { applyNarration, defineFilm, rect } from "../sdk/index.js";

test("narration is timestamped, extends portable scenes explicitly, and holds the final visual state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lucent-tts-"));
  try {
    const manifest = path.join(root, "story.film.json");
    fs.writeFileSync(path.join(root, "film.js"), "export default {};");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        apiVersion: "0.1.0",
        id: "story",
        renderer: "portable",
        adapter: "scenegraph",
        entry: "film.js",
        design: { width: 320, height: 180 },
        narration: { mode: "extend", tail: 0.25 },
      }),
    );
    const p = project(manifest),
      wav = path.join(root, "cue.wav");
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=24000:cl=mono",
      "-t",
      "0.6",
      "-c:a",
      "pcm_s16le",
      wav,
    ]);
    const timeline = {
      total: 3,
      scenes: [
        { id: "opening", start: 0, dur: 2 },
        { id: "closing", start: 2, dur: 1 },
      ],
    };
    const script = {
      schemaVersion: 1,
      film: "story",
      cues: [
        { id: "opening-line", scene: "opening", time: 1.7, text: "Hello." },
      ],
    };
    fs.writeFileSync(
      path.join(root, "narration.script.json"),
      JSON.stringify(script),
    );
    const generated = {
      schemaVersion: 1,
      cues: [{ cue: "opening-line", file: wav }],
    };
    const result = await assembleNarration(p, timeline, script, generated, {
      mode: "extend",
    });
    assert.ok(Math.abs(result.overrides[0].duration - 2.55) < 0.02);
    assert.ok(Math.abs(result.overrides[1].start - 2.55) < 0.02);
    assert.equal(result.total, result.overrides[1].start + 1);
    assert.equal(fs.existsSync(path.join(root, result.file)), true);
    const film = defineFilm({
      scenes: [
        { id: "opening", duration: 2, frame: (t) => rect(t, 0, 5, 5, "#fff") },
        { id: "closing", duration: 1, frame: () => rect(0, 0, 5, 5, "#000") },
      ],
    });
    const extended = applyNarration(film, result);
    assert.equal(extended.duration, result.total);
    assert.equal(extended.scenes[1].start, result.overrides[1].start);
    assert.equal(extended.scenes[0].frame(99).x, 2 - 1e-6);
    const tooLong = { ...script, cues: [{ ...script.cues[0], time: 1.7 }] };
    await assert.rejects(
      assembleNarration(p, timeline, tooLong, generated, { mode: "overlay" }),
      /extends opening/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
