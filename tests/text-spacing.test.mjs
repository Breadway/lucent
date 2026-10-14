import test from "node:test";
import assert from "node:assert/strict";
import { defineFilm, text } from "../sdk/index.js";
import { nativeBinary } from "../src/media.mjs";
import { run } from "../src/process.mjs";

test("text leaf carries letterSpacing, defaulting to absent (0 in the engine)", () => {
  const plain = text("KICKER", 30, 90, { font: "DejaVu Sans", size: 28 });
  assert.ok(!("letterSpacing" in plain));
  const spaced = text("KICKER", 30, 90, {
    font: "DejaVu Sans",
    size: 28,
    letterSpacing: 4,
  });
  assert.equal(spaced.letterSpacing, 4);
  assert.equal(spaced.type, "text");
});

test("portable scenes can require the text-letter-spacing capability", () => {
  const film = defineFilm({
    seed: 1,
    scenes: [
      {
        id: "kicker",
        duration: 2,
        renderer: "portable",
        requires: ["groups", "text", "text-letter-spacing"],
        frame: () => [
          text("KICKER", 30, 90, {
            font: "DejaVu Sans",
            size: 28,
            letterSpacing: 4,
          }),
        ],
      },
    ],
  });
  assert.deepEqual(film.scenes[0].requires, [
    "groups",
    "text",
    "text-letter-spacing",
  ]);
});

test(
  "native capabilities advertise text-letter-spacing",
  { skip: !process.env.FILM_NATIVE, timeout: 60000 },
  async () => {
    const caps = JSON.parse(await run(nativeBinary(), ["native-capabilities"]));
    assert.ok(caps.available, `native unavailable: ${caps.reason}`);
    assert.ok(
      caps.features.includes("text"),
      `missing text in ${caps.features}`,
    );
    assert.ok(
      caps.features.includes("text-letter-spacing"),
      `missing text-letter-spacing in ${caps.features}`,
    );
  },
);
