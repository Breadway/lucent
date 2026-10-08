import fs from "node:fs";
import path from "node:path";
import { run } from "../src/process.mjs";
import { atomicJSON } from "../src/project.mjs";
const config = JSON.parse(fs.readFileSync("docs/nasty-fixtures.json"));
const args = process.argv.slice(2),
  runSuite = args.includes("--run"),
  software = args.includes("--software");
if (!runSuite) {
  console.log(JSON.stringify(config, null, 2));
  process.exit(0);
}
const results = [];
for (const fixture of config.fixtures) {
  const inspect = JSON.parse(
    await run("node", ["cli.mjs", "inspect", fixture.project, "--json"]),
  );
  const scene = fixture.scene
    ? inspect.scenes.find((s) => s.id === fixture.scene)
    : inspect.scenes.find((s) => s.renderer !== "browser-only");
  if (fixture.scene && !scene)
    throw Error(`Fixture scene ${fixture.scene} missing in ${fixture.project}`);
  const from = scene?.start || 0,
    total = inspect.duration,
    to = Math.min(total, from + (config.clipSeconds || 4));
  if (to - from < 1 / config.fps)
    throw Error(`Fixture ${fixture.project} is too short to benchmark`);
  const name = path.basename(fixture.project, ".film.json");
  for (const size of config.resolutions)
    for (const workers of config.workers)
      for (const mb of config.motionBlurSamples)
        for (let repeat = 0; repeat < config.repetitions; repeat++) {
          const base = path.resolve(
            "out/bench",
            `${name}-${scene?.id || "all"}-${size}-w${workers}-mb${mb}-r${repeat}`,
          );
          const command = [
            "cli.mjs",
            "bench",
            fixture.project,
            "--size",
            size,
            "--from",
            String(from),
            "--to",
            String(to),
            "--fps",
            String(config.fps || 30),
            "--codec",
            config.codecs.join(","),
            "--encoder",
            software ? "software" : "auto",
            "--workers",
            String(workers),
            "--mb",
            String(mb),
            "--work",
            base,
            "--out",
            base + ".mp4",
            "--json",
          ];
          if (!software) command.push("--software-fallback");
          const report = JSON.parse(
            await run("node", command, { timeout: 1800000 }),
          );
          results.push({
            fixture: fixture.project,
            scene: scene?.id || null,
            features: fixture.features,
            ...report,
          });
          atomicJSON("out/bench/suite.json", {
            schemaVersion: 1,
            config,
            results,
          });
        }
}
