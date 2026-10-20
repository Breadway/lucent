import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { project } from "../src/project.mjs";
import { openNative } from "../src/native.mjs";
import { openFilm } from "../src/browser.mjs";

const ENGINE = path.resolve(import.meta.dirname, "..");
const NATIVE = { skip: !process.env.FILM_NATIVE, timeout: 600000 };

// Native and browser blur use different Gaussian approximations, so the cross-backend check is
// a bounded error, not identity. Measured bounds are recorded in docs/native-blur.md.
const BACKEND_TOLERANCE = 24;

function filmDir(name, width, height, leaves, background = "#000000", renderer = "portable") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lucent-blur-${name}-`));
  const requires = JSON.stringify(leaves).includes('"blur"') ? ["blur"] : [];
  fs.writeFileSync(
    path.join(root, "film.js"),
    `export default {apiVersion:"0.1.0",seed:1,background:${JSON.stringify(background)},duration:1,scenes:[{id:"s",start:0,duration:1,renderer:"${renderer}",requires:${JSON.stringify(requires)},dependencies:[],frame:()=>(${JSON.stringify(leaves)})}]};`,
  );
  fs.copyFileSync(path.join(ENGINE, "examples/conformance/DejaVuSans.ttf"), path.join(root, "DejaVuSans.ttf"));
  fs.writeFileSync(
    path.join(root, "g.film.json"),
    JSON.stringify({
      schemaVersion: 1,
      apiVersion: "0.1.0",
      id: "g",
      renderer: "portable",
      adapter: "scenegraph",
      entry: "film.js",
      design: { width, height },
      fonts: [{ family: "DejaVu Sans", file: "DejaVuSans.ttf", weight: 400, style: "normal" }],
    }),
  );
  return { root, p: project(path.join(root, "g.film.json")) };
}

// Renders natively REPEATS times and requires byte-identical output, returning the frame's
// 16-bit RGBA samples as a sampler.
async function renderNative(name, width, height, leaves, background) {
  const { root, p } = filmDir(name, width, height, leaves, background);
  const native = await openNative(p, { size: [width, height] });
  try {
    const first = (await native.capture(0)).png;
    const again = (await native.capture(0)).png;
    assert.ok(first.equals(again), `${name}: native repeat differs`);
    const img = PNG.sync.read(first, { skipRescale: true });
    return {
      png: first,
      at: (x, y) => [0, 1, 2].map((c) => img.data[(y * width + x) * 4 + c] / 257),
    };
  } finally {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function renderBrowser(name, width, height, leaves, background) {
  const { root, p } = filmDir(name, width, height, leaves, background);
  const browser = await openFilm(p, { size: [width, height], cpu: true });
  try {
    const img = PNG.sync.read((await browser.capture(0, 0)).png);
    return { at: (x, y) => [0, 1, 2].map((c) => img.data[(y * width + x) * 4 + c]) };
  } finally {
    await browser.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const row = (sample, y, xs) => xs.map((x) => sample(x, y));

// Native-only correctness checks. These run with FILM_NATIVE=1 and need the GPU renderer.
test("blur softens an edge symmetrically and conserves total coverage", NATIVE, async () => {
  const leaves = [{ type: "rect", x: 20, y: 0, width: 24, height: 40, color: "#ffffff", blur: 3 }];
  const r = await renderNative("symmetric", 64, 40, leaves);
  // The rect covers x in [20, 44). Its edges sit at x=20 and x=44, so mirror pixels are
  // 19 and 44 (outer) and 20 and 43 (inner, at the half-coverage edge).
  const leftEdge = r.at(20, 20)[0];
  const rightEdge = r.at(43, 20)[0];
  assert.ok(leftEdge > 0 && leftEdge < 255, `left edge not soft: ${leftEdge}`);
  assert.ok(rightEdge > 0 && rightEdge < 255, `right edge not soft: ${rightEdge}`);
  assert.ok(Math.abs(leftEdge - rightEdge) <= 2, `asymmetric edge ${leftEdge} vs ${rightEdge}`);
  assert.equal(r.at(4, 20)[0], 0);
  assert.equal(r.at(59, 20)[0], 0);
});

test("blur support extends beyond the leaf and clip cuts after blur", NATIVE, async () => {
  const leaves = [
    { type: "rect", x: 10, y: 10, width: 20, height: 20, color: "#ffffff", blur: 4 },
    // Clip is applied after blur, so the halo must stop at the clip edge.
    { type: "rect", x: 40, y: 10, width: 20, height: 20, color: "#ffffff", blur: 4, clip: [40, 0, 4, 40] },
  ];
  const r = await renderNative("support", 64, 40, leaves);
  // Halo reaches outside the rect.
  assert.ok(r.at(7, 20)[0] > 0, "no halo outside the leaf");
  // The clip keeps only x in [40, 44): samples beyond x=44 must be empty.
  assert.equal(r.at(46, 20)[0], 0, "clip did not cut blurred output");
  assert.ok(r.at(42, 20)[0] > 0, "clipped interior missing");
});

test("offscreen blurred leaf keeps its visible interior and halo", NATIVE, async () => {
  // The rect covers x in [-30, 10). Its right edge (x=10) is inside the frame and blurred.
  const leaves = [{ type: "rect", x: -30, y: 5, width: 40, height: 20, color: "#ffffff", blur: 2 }];
  const r = await renderNative("offscreen", 32, 32, leaves);
  assert.ok(r.at(5, 15)[0] > 250, `interior ${r.at(5, 15)}`);
  assert.ok(r.at(11, 15)[0] > 0 && r.at(11, 15)[0] < 250, `halo ${r.at(11, 15)}`);
  assert.equal(r.at(20, 15)[0], 0);
});

test("default and blur 0 leave output identical to the pre-change binary", NATIVE, async () => {
  const base = process.env.LUCENT_BASE_BIN;
  assert.ok(base, "set LUCENT_BASE_BIN to the pre-change binary for the default-path comparison");
  const plain = [
    { type: "rect", x: 2, y: 2, width: 20, height: 12, color: "#204060" },
    { type: "circle", x: 30, y: 15, radius: 9, color: "#00c0ff" },
  ];
  const zero = plain.map((leaf, i) => (i === 0 ? { ...leaf, blur: 0 } : leaf));
  const prev = process.env.LUCENT_NATIVE_BIN;
  const current = await renderNative("default-now", 40, 30, plain);
  const explicitZero = await renderNative("zero-now", 40, 30, zero);
  process.env.LUCENT_NATIVE_BIN = base;
  try {
    const old = await renderNative("default-base", 40, 30, plain);
    assert.ok(current.png.equals(old.png), "default path differs from pre-change binary");
    assert.ok(explicitZero.png.equals(old.png), "blur 0 differs from pre-change binary");
  } finally {
    if (prev === undefined) delete process.env.LUCENT_NATIVE_BIN;
    else process.env.LUCENT_NATIVE_BIN = prev;
  }
});

test("group, image and text nodes reject blur on both backends", NATIVE, async () => {
  for (const bad of [
    { type: "group", blur: 2, children: [] },
    { type: "text", text: "x", x: 0, y: 0, font: "DejaVu Sans", blur: 2 },
  ]) {
    const { root, p } = filmDir("reject", 16, 16, [bad]);
    // Both backends reject during the first render, not at open.
    const native = await openNative(p, { size: [16, 16] });
    const nativeErr = await native.capture(0).then(() => null, (e) => e);
    await native.close();
    assert.ok(nativeErr && /blur/.test(nativeErr.message), `native accepted ${bad.type}: ${nativeErr}`);
    const browser = await openFilm(p, { size: [16, 16], cpu: true });
    const browserErr = await browser.capture(0, 0).then(() => null, (e) => e);
    await browser.close();
    assert.ok(browserErr && /blur/.test(browserErr.message), `browser accepted ${bad.type}: ${browserErr}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hostile blur values are rejected before rendering", NATIVE, async () => {
  for (const value of [-1, 129, 1e9, "3"]) {
    const { root, p } = filmDir("hostile", 16, 16, [
      { type: "rect", x: 0, y: 0, width: 8, height: 8, color: "#fff", blur: value },
    ]);
    const native = await openNative(p, { size: [16, 16] });
    const err = await native.capture(0).then(() => null, (e) => e);
    await native.close();
    assert.ok(err instanceof Error, `native accepted blur ${JSON.stringify(value)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a sigma far below one pixel renders like no blur", NATIVE, async () => {
  const leaf = (blur) => [
    { type: "rect", x: 10, y: 5, width: 20, height: 20, color: "#336699", ...(blur === undefined ? {} : { blur }) },
  ];
  const plain = await renderNative("tiny-plain", 40, 30, leaf());
  // f32 squared the first sigma to zero and produced a NaN kernel, which rendered
  // the whole leaf white. The second narrows to f32 zero and must be treated as
  // no blur rather than reaching the kernel as a division by zero.
  for (const sigma of [1e-30, 1e-46]) {
    const tiny = await renderNative("tiny-zero", 40, 30, leaf(sigma));
    assert.ok(tiny.png.equals(plain.png), `sigma ${sigma} changed the frame: ${tiny.at(20, 15)} vs ${plain.at(20, 15)}`);
  }
});

test("native blur agrees with the browser reference within a bounded error", NATIVE, async () => {
  const leaves = [{ type: "rect", x: 16, y: 8, width: 32, height: 16, color: "#ffffff", blur: 2 }];
  const n = await renderNative("ref-native", 64, 32, leaves);
  const b = await renderBrowser("ref-browser", 64, 32, leaves);
  let worst = 0;
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 64; x++) {
      const a = n.at(x, y)[0];
      const c = b.at(x, y)[0];
      worst = Math.max(worst, Math.abs(a - c));
    }
  assert.ok(worst <= BACKEND_TOLERANCE, `max channel error ${worst} exceeds ${BACKEND_TOLERANCE}`);
});
