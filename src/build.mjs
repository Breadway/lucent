import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { ENGINE } from "./server.mjs";
import { bundlePath } from "./project.mjs";
import { narrationTiming } from "./narration.mjs";
export async function bundle(p, { native = false } = {}) {
  const out = bundlePath(p, { native });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await build({
    stdin: {
      contents: `import authored from ${JSON.stringify(path.join(p.root, p.entry))};import {frameGraph,applyNarration} from ${JSON.stringify(path.join(ENGINE, "sdk/index.js"))};const film=applyNarration(authored,${JSON.stringify(narrationTiming(p)) || "undefined"});export default film;export const graph=(t,fps=30)=>frameGraph(film,t,fps);`,
      resolveDir: p.root,
      sourcefile: "engine-entry.js",
    },
    outfile: out,
    bundle: true,
    format: native ? "iife" : "esm",
    globalName: native ? "FilmBundle" : undefined,
    platform: "neutral",
    target: "es2020",
    sourcemap: "external",
    alias: { "@breadway/lucent": path.join(ENGINE, "sdk/index.js") },
    // Browser-served films import engine modules by absolute URL (/engine/...).
    plugins: [
      {
        name: "engine-url",
        setup(b) {
          b.onResolve({ filter: /^\/engine\// }, (args) => ({
            path: path.join(ENGINE, args.path.slice("/engine/".length)),
          }));
        },
      },
    ],
    logLevel: "silent",
  });
  return out;
}
