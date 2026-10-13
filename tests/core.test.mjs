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
  bundlePath,
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
test("native and browser bundles are keyed by manifest", async () => {
  const { bundle } = await import("../src/build.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "film-bundle-"));
  try {
    const films = {};
    for (const name of ["alpha", "beta"]) {
      fs.writeFileSync(
        path.join(root, `${name}.js`),
        `export default { marker: ${JSON.stringify(`${name}-marker`)}, scenes: [] };\n`,
      );
      films[name] = {
        root,
        entry: `${name}.js`,
        manifestFile: path.join(root, `${name}.film.json`),
      };
    }
    const outA = await bundle(films.alpha, { native: true });
    const outB = await bundle(films.beta, { native: true });
    assert.notEqual(outA, outB);
    assert.match(path.basename(outA), /^native-alpha-[0-9a-f]{8}\.js$/);
    assert.match(path.basename(outB), /^native-beta-[0-9a-f]{8}\.js$/);
    assert.equal(bundlePath(films.alpha, { native: true }), outA);
    assert.equal(bundlePath(films.beta, { native: true }), outB);
    const browserA = bundlePath(films.alpha);
    assert.match(path.basename(browserA), /^browser-alpha-[0-9a-f]{8}\.js$/);
    assert.notEqual(browserA, outA);
    const contentsA = fs.readFileSync(outA, "utf8");
    const contentsB = fs.readFileSync(outB, "utf8");
    assert.match(contentsA, /alpha-marker/);
    assert.match(contentsB, /beta-marker/);
    assert.doesNotMatch(contentsA, /beta-marker/);
    assert.doesNotMatch(contentsB, /alpha-marker/);
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
