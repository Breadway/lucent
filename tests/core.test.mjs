import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineFilm, frameGraph, rng, sourceTime } from "../sdk/index.js";
import {
  resolution,
  frameTime,
  cacheKey,
  sceneBackends,
  project,
} from "../src/project.mjs";
import { lease } from "../src/process.mjs";
test("rational timeline timestamps and deterministic out-of-order seeks", () => {
  assert.equal(frameTime(30000, "30000/1001"), 1001);
  const film = defineFilm({
    scenes: [
      {
        id: "a",
        duration: 4,
        frame(t, { random }) {
          return { type: "rect", x: t, color: String(random()) };
        },
      },
    ],
  });
  const first = frameGraph(film, 1);
  frameGraph(film, 3);
  assert.deepEqual(frameGraph(film, 1), first);
  assert.throws(() =>
    defineFilm({
      scenes: [
        { id: "a", duration: 1 },
        { id: "a", duration: 1 },
      ],
    }),
  );
  assert.equal(sourceTime(5, { trim: 2, rate: 2, duration: 3, loop: true }), 3);
});
test("cache version/settings and explicit backend diagnostics", () => {
  assert.notEqual(
    cacheKey({}, { backend: "browser", width: 1920 }, "dep"),
    cacheKey({}, { backend: "native", width: 1920 }, "dep"),
  );
  assert.notEqual(
    cacheKey({}, { backend: "browser", width: 1920 }, "dep"),
    cacheKey({}, { backend: "browser", width: 3840 }, "dep"),
  );
  const caps = {
    browser: { available: true, features: ["dom"] },
    native: { available: true, features: ["paths"] },
  };
  assert.equal(
    sceneBackends({ renderer: "browser-only" }, caps).native.available,
    false,
  );
  assert.match(
    sceneBackends({ renderer: "portable", requires: ["text"] }, caps).native
      .reasons[0],
    /text/,
  );
});
test("dimensions, unsupported schemas, and shared resource leases fail early", () => {
  assert.deepEqual(resolution("1200p"), [1920, 1200]);
  assert.throws(() => resolution("1921x1080"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "film-core-"));
  try {
    const release = lease(root, "gpu", 1);
    assert.throws(() => lease(root, "gpu", 1), /in use/);
    release();
    lease(root, "gpu", 1)();
    fs.writeFileSync(
      path.join(root, "film.json"),
      JSON.stringify({ schemaVersion: 2 }),
    );
    assert.throws(() => project(path.join(root, "film.json")), /schemaVersion/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("extension versions reject incompatible providers", async () => {
  const { extensionRegistry } = await import("../sdk/index.js");
  const registry = extensionRegistry();
  assert.throws(
    () => registry.register("tts", "old", { apiVersion: "0.0.1" }),
    /Incompatible/,
  );
  registry.register("tts", "local", {
    apiVersion: "0.1.0",
    capabilities: ["offline"],
  });
  assert.deepEqual(registry.capabilities()[0].capabilities, ["offline"]);
});
