import fs from "node:fs";
import path from "node:path";
import { openFilm } from "./browser.mjs";
import { atomicJSON } from "./project.mjs";
import { run } from "./process.mjs";
import { ENGINE } from "./server.mjs";
import { validateScript, assembleNarration } from "./narration.mjs";
import { extension } from "./extensions.mjs";
export async function tts(p, o) {
  const out = path.join(p.root, "out/tts"),
    script = o.script
      ? path.resolve(o.script)
      : path.join(p.root, "narration.script.json");
  if (!fs.existsSync(script)) {
    const film = await openFilm({ ...p, narration: { disabled: true } });
    try {
      atomicJSON(script, {
        schemaVersion: 1,
        film: p.id,
        cues: film.timeline.scenes.flatMap((s) =>
          (s.caps || []).map(([time, text], i) => ({
            id: `${s.id}-${i + 1}`,
            scene: s.id,
            time,
            text: text.replaceAll("*", ""),
          })),
        ),
      });
    } finally {
      await film.close();
    }
  }
  const config = o.config
    ? path.resolve(o.config)
    : path.join(p.root, "tts.config.json");
  if (!fs.existsSync(config))
    atomicJSON(config, {
      schemaVersion: 1,
      provider: "gemini",
      apiVersion: "0.1.0",
      model: "gemini-3.8-flash-lite-tts",
      voice: "Sadaltager",
      limits: { rpm: 3, tpm: 10000, rpd: 10, concurrency: 1 },
      keys: [{ env: "GKEY", project: "default" }],
    });
  const cfg = JSON.parse(fs.readFileSync(config));
  const scriptData = validateScript(p, JSON.parse(fs.readFileSync(script)));
  let generated;
  if (cfg.schemaVersion !== 1 || cfg.apiVersion !== "0.1.0")
    throw Error("Unsupported TTS configuration version");
  if (cfg.provider === "existing") {
    generated = {
      schemaVersion: 1,
      cues: scriptData.cues.map((c) => {
        if (!c.audio) throw Error(`Missing existing audio for ${c.id}`);
        return {
          cue: c.id,
          scene: c.scene,
          time: c.time,
          file: path.resolve(p.root, c.audio),
        };
      }),
    };
  } else if (cfg.provider === "gemini") {
    const budget = Number(o["max-requests"] || 0);
    if (!Number.isInteger(budget) || budget < 0)
      throw Error("max-requests must be a nonnegative integer");
    generated = JSON.parse(
      await run(
        "python3",
        [
          path.join(ENGINE, "tools/tts.py"),
          "--config",
          config,
          "--script",
          script,
          "--out",
          out,
          "--max-requests",
          String(budget),
        ],
        { timeout: 1800000 },
      ),
    );
  } else {
    const provider = await extension(p, "tts", cfg.provider);
    if (typeof provider.generate !== "function")
      throw Error("TTS provider requires generate()");
    generated = await provider.generate({
      project: p,
      config: cfg,
      script: scriptData,
      out,
      maxRequests: Number(o["max-requests"] || 0),
      signal: (await import("./process.mjs")).aborter.signal,
    });
  }
  if (generated.schemaVersion !== 1 || !Array.isArray(generated.cues))
    throw Error("Invalid TTS provider output");
  if (generated.cues.every((c) => c.file)) {
    const film = await openFilm({ ...p, narration: { disabled: true } });
    try {
      generated.assembly = await assembleNarration(
        p,
        film.timeline,
        scriptData,
        generated,
        { mode: o.mode || p.narration?.mode || "overlay", out },
      );
    } finally {
      await film.close();
    }
  }
  return generated;
}
