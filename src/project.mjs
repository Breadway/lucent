import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const VERSION = "0.1.0",
  CACHE_VERSION = 1;
const engineRoot = path.resolve(import.meta.dirname, "..");
let buildFingerprint;
export function engineFingerprint() {
  if (buildFingerprint) return buildFingerprint;
  const files = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (/\.(mjs|js|rs)$/.test(name))
        files.push([
          path.relative(engineRoot, file),
          hash(fs.readFileSync(file)),
        ]);
    }
  }
  for (const dir of ["src", "sdk", "web", "compat"])
    walk(path.join(engineRoot, dir));
  for (const name of ["Cargo.lock", "package-lock.json"])
    files.push([name, hash(fs.readFileSync(path.join(engineRoot, name)))]);
  return (buildFingerprint = hash(files));
}
export const PRESETS = {
  "4k": [3840, 2160],
  "1440p": [2560, 1440],
  "1200p": [1920, 1200],
  "1080p": [1920, 1080],
};
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  return value;
}
export const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(stable(value)),
    )
    .digest("hex");
export function hashFile(file) {
  const digest = createHash("sha256"),
    fd = fs.openSync(file, "r"),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      digest.update(buffer.subarray(0, bytes));
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest("hex");
}
export function inside(root, file) {
  const p = path.resolve(root, file);
  if (p !== root && !p.startsWith(root + path.sep))
    throw Error(`Path escapes project: ${file}`);
  const actual = fs.realpathSync(p);
  if (actual !== root && !actual.startsWith(root + path.sep))
    throw Error(`Symlink escapes project: ${file}`);
  return actual;
}
export function project(file) {
  const manifestFile = fs.realpathSync(file),
    root = path.dirname(manifestFile),
    m = JSON.parse(fs.readFileSync(manifestFile));
  if (m.schemaVersion !== 1)
    throw Error(
      `Unsupported schemaVersion ${m.schemaVersion}; expected 1. Migrate a backup explicitly.`,
    );
  if (m.apiVersion !== VERSION)
    throw Error(
      `Unsupported API ${m.apiVersion}; this engine provides ${VERSION}`,
    );
  if (!/^[a-zA-Z0-9_-]+$/.test(m.id || ""))
    throw Error("id must contain letters, digits, hyphens or underscores");
  if (!["browser-only", "portable", "native-only"].includes(m.renderer))
    throw Error("Declare renderer: browser-only, portable, or native-only");
  if (!["astra", "breadway", "scenegraph", "custom"].includes(m.adapter))
    throw Error("Unsupported adapter");
  for (const k of ["width", "height"])
    if (
      !Number.isInteger(m.design?.[k]) ||
      m.design[k] < 2 ||
      m.design[k] > 16384
    )
      throw Error(`Invalid design.${k}`);
  inside(root, m.entry);
  for (const e of m.extensions || []) inside(root, e.file);
  for (const d of m.dependencies || [])
    inside(root, typeof d === "string" ? d : d.path);
  for (const font of m.fonts || []) inside(root, font.file);
  for (const file of [
    m.audio?.file,
    m.narration?.file,
    m.narration?.timeline,
    m.narration?.script,
  ])
    if (file) inside(root, file);
  for (const track of m.audio?.tracks || [])
    if (track.src) inside(root, track.src);
  for (const mode of Object.values(m.pacing || {}))
    if (mode?.audio) inside(root, mode.audio);
  return { ...m, root, manifestFile };
}
export function sourceFingerprint(p) {
  const files = new Map();
  function visit(f) {
    const resolved = inside(p.root, f),
      s = fs.statSync(resolved);
    if (s.isDirectory())
      for (const n of fs.readdirSync(resolved).sort())
        visit(path.relative(p.root, path.join(resolved, n)));
    else files.set(f, hashFile(resolved));
  }
  if (p.adapter !== "scenegraph") {
    for (const n of fs.readdirSync(p.root).sort())
      if (!["out", ".cache", "node_modules"].includes(n) && !n.startsWith("."))
        visit(n);
  } else
    for (const d of [
      p.entry,
      ...(p.dependencies || []),
      ...(p.extensions || []).map((e) => e.file),
      ...(p.fonts || []).map((f) => f.file),
    ])
      visit(typeof d === "string" ? d : d.path);
  if (p.narration?.file && fs.existsSync(path.join(p.root, p.narration.file)))
    visit(p.narration.file);
  for (const file of [
    "out/tts/timeline.json",
    "narration.script.json",
    p.narration?.timeline,
  ])
    if (file && fs.existsSync(path.join(p.root, file))) visit(file);
  if (p.audio?.file && fs.existsSync(path.join(p.root, p.audio.file)))
    visit(p.audio.file);
  for (const track of p.audio?.tracks || []) visit(track.src);
  for (const track of p.audio?.tracks || [])
    if (track.dependency) visit(track.dependency);
  return hash({
    cacheVersion: CACHE_VERSION,
    engine: VERSION,
    manifest: p,
    files: [...files],
  });
}
export function resolution(value = "1080p") {
  const r = PRESETS[value] || value.split("x").map(Number);
  if (
    r.length !== 2 ||
    r.some((n) => !Number.isInteger(n) || n < 2 || n > 16384 || n % 2)
  )
    throw Error("Size must be a preset or even WIDTHxHEIGHT (2..16384)");
  return r;
}
export function number(v, name, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max)
    throw Error(`${name} must be between ${min} and ${max}`);
  return n;
}
export function frameTime(frame, fps) {
  const [n, d] = String(fps).split("/").map(Number);
  return (frame * (d || 1)) / n;
}
export function frameRate(fps) {
  const n = 1 / frameTime(1, fps);
  if (!Number.isFinite(n) || n < 1 || n > 240) throw Error("Invalid fps");
  return n;
}
export function cacheKey(p, settings, dependencies = sourceFingerprint(p)) {
  return hash({
    version: CACHE_VERSION,
    engine: VERSION,
    build: engineFingerprint(),
    backend: settings.backend,
    dependencies,
    settings,
  });
}
export function bundlePath(p, { native = false } = {}) {
  const kind = native ? "native" : "browser";
  const abs = path.resolve(
    p.manifestFile || path.join(p.root, p.entry || "film"),
  );
  let base = path.basename(abs);
  if (/\.film\.json$/i.test(base)) base = base.slice(0, -".film.json".length);
  else if (path.extname(base)) base = base.slice(0, -path.extname(base).length);
  base = base.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!base) base = "film";
  return path.join(
    p.root,
    ".cache",
    `${kind}-${base}-${hash(abs).slice(0, 8)}.js`,
  );
}
export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.part`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temp, file);
}
export function sceneBackends(scene, capabilities) {
  const classification = scene.renderer || "portable";
  return Object.fromEntries(
    ["browser", "native"].map((backend) => {
      const reasons = [];
      if (
        classification ===
        (backend === "browser" ? "native-only" : "browser-only")
      )
        reasons.push(`Scene is ${classification}`);
      const caps = capabilities[backend];
      if (!caps?.available) reasons.push(caps?.reason || "Backend unavailable");
      for (const required of scene.requires || [])
        if (!caps?.features?.includes(required))
          reasons.push(`Missing capability: ${required}`);
      return [backend, { available: reasons.length === 0, reasons }];
    }),
  );
}
