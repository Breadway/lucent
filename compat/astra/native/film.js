// Runs an Astra (DOM/SVG) film natively: the film's own scene code executes unchanged against
// the minimal DOM in ./dom.js, and the Stage in ./stage.js turns each frame into one SVG
// document for the native renderer.
import { defineFilm } from "@breadway/lucent";
import { installDocument } from "./dom.js";
import { Stage, FPS } from "./stage.js";

const GRAIN = { width: 320, height: 180, opacity: 0.055 };

export function createAstraFilm({
  scenes,
  narration = null,
  opts = {},
  background = "#070c15",
}) {
  installDocument();
  const stage = new Stage(scenes, narration, opts);
  const common = { renderer: "portable", requires: ["svg"] };
  return defineFilm({
    seed: 0,
    background,
    scenes: [
      // One entry per authored scene keeps the timeline (ids, starts, durations, captions)
      // identical to the browser film's; the stage scene below draws all of them.
      ...stage.timeline().scenes.map((s) => ({
        id: s.id,
        start: s.start,
        duration: s.dur,
        caps: s.caps,
        ...common,
        frame: () => [],
      })),
      {
        id: "astra-stage",
        start: 0,
        duration: stage.total,
        ...common,
        frame(t) {
          const frame = Math.round(t * FPS);
          return {
            type: "svg",
            markup: stage.seek(t, frame),
            grain: { seed: frame * 7919, ...GRAIN },
          };
        },
      },
    ],
  });
}
