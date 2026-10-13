import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { project, atomicJSON } from "../src/project.mjs";
import { openFilm } from "../src/browser.mjs";
const roots = ["../lucent-films/astra-films", "../lucent-films/breadway-film-projects"];
const results = [];
for (const root of roots)
  for (const name of fs
    .readdirSync(root)
    .filter((n) => n.endsWith(".film.json"))) {
    const p = project(path.join(root, name));
    let film;
    try {
      film = await openFilm(p, { size: [640, 360], cpu: true });
      const failures = [];
      for (const scene of film.timeline.scenes) {
        for (const t of [
          scene.start + 0.01,
          scene.start + scene.dur * 0.5,
          scene.start + scene.dur - 0.01,
        ]) {
          try {
            const a = await film.capture(Math.max(0, t), Math.round(t * 30));
            const bytes = PNG.sync.read(a.png);
            if (bytes.width !== 640 || bytes.height !== 360)
              throw Error("bad dimensions");
          } catch (e) {
            failures.push({ scene: scene.id, time: t, error: e.message });
            break;
          }
        }
      }
      const t = Math.min(10, film.timeline.total / 2),
        a = await film.capture(t, Math.round(t * 30));
      await film.capture(0, 0);
      const b = await film.capture(t, Math.round(t * 30));
      const deterministic = PNG.sync
        .read(a.png)
        .data.equals(PNG.sync.read(b.png).data);
      results.push({
        project: p.id,
        scenes: film.timeline.scenes.length,
        deterministic,
        failures,
      });
      console.log(
        `${p.id}: ${film.timeline.scenes.length} scenes, ${failures.length} failures, deterministic=${deterministic}`,
      );
    } catch (e) {
      results.push({ project: p.id, failures: [{ error: e.message }] });
      console.error(p.id, e.message);
    } finally {
      if (film) await film.close();
    }
  }
atomicJSON("docs/migration-verification.json", {
  schemaVersion: 1,
  environment: "Chromium headless CPU",
  passed: results.every((r) => r.deterministic && !r.failures.length),
  results,
});
if (results.some((r) => r.failures.length || !r.deterministic))
  process.exitCode = 1;
