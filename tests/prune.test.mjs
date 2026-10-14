import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "../src/project.mjs";
import { pruneChunkFrames, restoreChunk } from "../src/render.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function chunkDir() {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "film-prune-"));
  const dir = path.join(cache, "0-2");
  fs.mkdirSync(dir, { recursive: true });
  return { cache, dir };
}

function writeChunk(dir, { key = "key", frames = [0, 1], segment = true }) {
  for (const f of frames)
    fs.writeFileSync(path.join(dir, `${f}.png`), Buffer.from(`png-${f}`));
  fs.writeFileSync(
    path.join(dir, "frames.json"),
    JSON.stringify({ schemaVersion: 1, frames }),
  );
  const file = path.join(dir, "h264.mp4");
  if (segment) {
    fs.writeFileSync(file, Buffer.from("segment"));
    fs.writeFileSync(
      file + ".json",
      JSON.stringify({ schemaVersion: 1, key, checksum: hashFile(file) }),
    );
  }
  return file;
}

test("verified chunk restores without its PNG frames", async () => {
  const { cache, dir } = chunkDir();
  try {
    const file = writeChunk(dir, { frames: [] });
    let seen;
    const ok = async (...args) => {
      seen = args;
      return {};
    };
    const restored = await restoreChunk({
      dir,
      a: 0,
      b: 2,
      key: "key",
      codecs: ["h264"],
      settings: {},
      verify: ok,
    });
    assert.deepEqual(restored, { h264: file });
    assert.equal(seen[1].frames, 2);
    assert.equal(seen[1].codec, "h264");
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test("pruning keeps the segment and manifests", async () => {
  const { cache, dir } = chunkDir();
  try {
    const file = writeChunk(dir, {});
    const restored = await restoreChunk({
      dir,
      a: 0,
      b: 2,
      key: "key",
      codecs: ["h264"],
      settings: {},
      verify: async () => ({}),
    });
    assert.ok(restored);
    pruneChunkFrames(dir, 0, 2);
    assert.equal(fs.existsSync(path.join(dir, "0.png")), false);
    assert.equal(fs.existsSync(path.join(dir, "1.png")), false);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(file + ".json"), true);
    assert.equal(fs.existsSync(path.join(dir, "frames.json")), true);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test("failed verification keeps every PNG frame", async () => {
  const { cache, dir } = chunkDir();
  try {
    writeChunk(dir, {});
    const restored = await restoreChunk({
      dir,
      a: 0,
      b: 2,
      key: "key",
      codecs: ["h264"],
      settings: {},
      verify: async () => {
        throw Error("Output validation failed");
      },
    });
    assert.equal(restored, null);
    assert.equal(fs.existsSync(path.join(dir, "0.png")), true);
    assert.equal(fs.existsSync(path.join(dir, "1.png")), true);
    assert.equal(fs.existsSync(path.join(dir, "h264.mp4")), true);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test("stale record key is not restored", async () => {
  const { cache, dir } = chunkDir();
  try {
    writeChunk(dir, { key: "old" });
    let calls = 0;
    const restored = await restoreChunk({
      dir,
      a: 0,
      b: 2,
      key: "key",
      codecs: ["h264"],
      settings: {},
      verify: async () => {
        calls++;
        return {};
      },
    });
    assert.equal(restored, null);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(path.join(dir, "0.png")), true);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test("missing segment record is not restored", async () => {
  const { cache, dir } = chunkDir();
  try {
    writeChunk(dir, { segment: false });
    const restored = await restoreChunk({
      dir,
      a: 0,
      b: 2,
      key: "key",
      codecs: ["h264"],
      settings: {},
      verify: async () => ({}),
    });
    assert.equal(restored, null);
    assert.equal(fs.existsSync(path.join(dir, "0.png")), true);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test("--keep-frames is documented in help and README", () => {
  const help = execFileSync("node", [path.join(ROOT, "cli.mjs"), "help"], {
    encoding: "utf8",
  });
  assert.match(help, /--keep-frames/);
  assert.match(
    fs.readFileSync(path.join(ROOT, "README.md"), "utf8"),
    /--keep-frames/,
  );
});
