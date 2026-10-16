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
// Native and browser 8-bit values round independently, so allow 1.5 levels.
const TOLERANCE = 1.5;
const REPEATS = 3;

// Linear-light reference used by the definition checks below.
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);
const lin3 = (rgb) => rgb.map((v) => lin(v / 255));
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

// Expected 8-bit sRGB of a leaf of straight colour `src` at alpha `a` (already including
// opacity) composited over `dst` (8-bit sRGB), in linear light.
function expectNormal(dst, src, a) {
  return [0, 1, 2].map((c) => 255 * enc(lin(src[c] / 255) * a + lin(dst[c] / 255) * (1 - a)));
}
function expectLighter(dst, src, a) {
  return [0, 1, 2].map((c) => 255 * enc(lin(dst[c] / 255) + lin(src[c] / 255) * a));
}

function filmDir(name, width, height, leaves, background = "#000000", capabilities) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lucent-blend-${name}-`));
  // Only films that use a non-default blend declare the capability, so a
  // normal-only film stays loadable by binaries that predate blend-lighter.
  const required = capabilities ?? (JSON.stringify(leaves).includes('"blend"') ? ["blend-lighter"] : []);
  fs.writeFileSync(
    path.join(root, "film.js"),
    `export default {apiVersion:"0.1.0",seed:1,background:${JSON.stringify(background)},duration:1,scenes:[{id:"s",start:0,duration:1,renderer:"${capabilities ? "native-only" : "portable"}",requires:${JSON.stringify(required)},dependencies:[],frame:()=>(${JSON.stringify(leaves)})}]};`,
  );
  // Text leaves need a declared, embedded font. Reuse the conformance font file.
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

// Renders natively and in Chromium, REPEATS times each, and requires byte-identical repeats.
async function render(name, width, height, leaves, background) {
  const { root, p } = filmDir(name, width, height, leaves, background);
  const native = await openNative(p, { size: [width, height] });
  // cpu: true passes --disable-gpu. Chromium still provides WebGL2 through SwiftShader, so this
  // exercises the WebGL compositor path, not the JavaScript CPU path (see docs/native-blend.md).
  const browser = await openFilm(p, { size: [width, height], cpu: true });
  try {
    const frames = [];
    const reference = [];
    for (let i = 0; i < REPEATS; i++) {
      frames.push((await native.capture(0)).png);
      reference.push((await browser.capture(0, 0)).png);
    }
    for (let i = 1; i < REPEATS; i++) {
      assert.ok(frames[i].equals(frames[0]), `${name}: native run ${i} differs`);
      assert.ok(reference[i].equals(reference[0]), `${name}: browser run ${i} differs`);
    }
    const n = PNG.sync.read(frames[0], { skipRescale: true });
    const b = PNG.sync.read(reference[0]);
    const at = (img, x, y, scale) => [0, 1, 2].map((c) => img.data[(y * width + x) * 4 + c] / scale);
    return {
      native: (x, y) => at(n, x, y, 257),
      browser: (x, y) => at(b, x, y, 1),
    };
  } finally {
    await native.close();
    await browser.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

test("additive overlap matches linear-light expectation in both renderers", NATIVE, async () => {
  const dst = [64, 64, 64];
  const leaves = [
    { type: "rect", x: 0, y: 0, width: 4, height: 4, color: "#404040" },
    { type: "rect", x: 2, y: 0, width: 4, height: 4, color: "#404040", blend: "lighter" },
  ];
  const r = await render("overlap", 8, 4, leaves);
  const sum = expectLighter(dst, dst, 1);
  // Only-A (x=1), overlap (x=3), only-B (x=5) and background-only (x=6).
  const cases = [
    [1, expectNormal([0, 0, 0], dst, 1)],
    [3, sum],
    [5, expectNormal([0, 0, 0], dst, 1)],
    [6, [0, 0, 0]],
  ];
  for (const [x, want] of cases) {
    assert.ok(dist(r.native(x, 1), want) <= TOLERANCE, `native x=${x} ${r.native(x, 1)} vs ${want}`);
    assert.ok(dist(r.browser(x, 1), want) <= TOLERANCE, `browser x=${x} ${r.browser(x, 1)} vs ${want}`);
  }
});

test("partial alpha, clip and group opacity apply to lighter leaves like normal leaves", NATIVE, async () => {
  const base = "#302010";
  const leaves = [
    { type: "rect", x: 0, y: 0, width: 12, height: 4, color: base },
    // Half-transparent additive source over the base: contributes src * 0.5.
    { type: "rect", x: 0, y: 0, width: 6, height: 4, color: "#80808080", blend: "lighter" },
    // Group clip cuts the additive leaf at x=9, and group opacity 0.5 scales it.
    {
      type: "group",
      opacity: 0.5,
      clip: [6, 0, 3, 4],
      children: [{ type: "rect", x: 6, y: 0, width: 6, height: 4, color: "#ffffff", blend: "lighter" }],
    },
  ];
  const r = await render("partial", 12, 4, leaves, "#000000");
  const b = hex(base);
  // The base rect is a normal leaf, so x=2 is base + (#808080 at alpha 128/255) added in
  // linear light. Lighter ignores destination alpha; source alpha scales the add.
  const half = expectLighter(b, [128, 128, 128], 128 / 255);
  // Group opacity 0.5 scales the white leaf: at x=7 it adds white at alpha 0.5 over base.
  const grouped = expectLighter(b, [255, 255, 255], 0.5);
  // x=10 is outside the group clip (x 6..9): only the base rect shows.
  const outside = b;
  const cases = [
    [2, half, "partial alpha"],
    [7, grouped, "group opacity and clip"],
    [10, outside, "outside group clip"],
  ];
  for (const [x, want, label] of cases) {
    assert.ok(dist(r.native(x, 2), want) <= TOLERANCE, `native ${label} x=${x} ${r.native(x, 2)} vs ${want}`);
    assert.ok(dist(r.browser(x, 2), want) <= TOLERANCE, `browser ${label} x=${x} ${r.browser(x, 2)} vs ${want}`);
  }
});

// Native-only: a shader node writes a translucent texel (alpha 0.5), a lighter leaf is applied
// on top, and a read-back shader exposes the frame texel. The frame contract is opaque, so the
// fixture asserts the intended behaviour (destination alpha is kept) and documents that Canvas
// lighter would give alpha 1.0 here (min(1, 0.5 + 0.5)). It does not claim the two match.
test("lighter keeps translucent destination alpha (intended contract, documented divergence)", NATIVE, async () => {
  const vs = `@vertex fn vs(@builtin(vertex_index) id: u32) -> @builtin(position) vec4<f32> { var p=array<vec2<f32>,3>(vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.)); return vec4(p[id],0.,1.); }`;
  const set = `${vs} @fragment fn fs(@builtin(position) q: vec4<f32>) -> @location(0) vec4<f32> { return vec4<f32>(0.0,0.0,0.0,0.5); }`;
  const readAlpha = `${vs} @group(0) @binding(0) var t: texture_2d<f32>; @fragment fn fs(@builtin(position) q: vec4<f32>) -> @location(0) vec4<f32> { let a = textureLoad(t, vec2<i32>(q.xy), 0); return vec4<f32>(a.a, a.a, a.a, 1.0); }`;
  const white50 = { type: "rect", x: 0, y: 0, width: 4, height: 4, color: "#ffffff", opacity: 0.5 };
  const readout = async (leaves) => {
    const { root, p } = filmDir(
      "alpha-keep",
      4,
      4,
      [{ type: "shader", wgsl: set }, ...leaves, { type: "shader", wgsl: readAlpha }],
      "#000000",
      ["shader-wgsl", "blend-lighter"],
    );
    const native = await openNative(p, { size: [4, 4] });
    try {
      const png = PNG.sync.read((await native.capture(0)).png, { skipRescale: true });
      return png.data[(1 * 4 + 1) * 4] / 257;
    } finally {
      await native.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const control = await readout([{ ...white50 }]);
  const lighter = await readout([{ ...white50, blend: "lighter" }]);
  // Source-over control: alpha = 0.5 + 0.5 * 0.5 = 0.75. Lighter keeps 0.5.
  assert.ok(Math.abs(lighter - 255 * enc(0.5)) <= 1.5, `lighter alpha ${lighter} should keep 0.5`);
  assert.ok(Math.abs(control - 255 * enc(0.75)) <= 1.5, `normal control alpha ${control} should be 0.75`);
});

// Native and browser text rasterise glyph edges differently (the existing documented divergence
// for text), so a native-vs-browser bound on text cannot test blending. Instead each backend's
// lighter text is compared with its own normal text, and the additive definition is checked
// where the glyph is fully covered (the interior of the stem).
test("lighter text leaf adds linear light on each backend (glyph coverage compared to itself)", NATIVE, async () => {
  const base = [
    { type: "rect", x: 0, y: 0, width: 40, height: 20, color: "#302010" },
  ];
  const glyph = (blend) => ({ type: "text", x: 2, y: 16, size: 16, font: "DejaVu Sans", text: "A", color: "#808080", ...(blend ? { blend } : {}) });
  const lighter = await render("text-lighter", 40, 20, [...base, glyph("lighter")]);
  const normal = await render("text-normal", 40, 20, [...base, glyph(null)]);
  // The glyph's coverage per pixel is recovered from the same backend's normal render:
  // normal = dst*(1-a) + src*a in linear light, so a = (normal - dst) / (src - dst).
  // Lighter at that coverage must then equal dst + src*a, on that backend.
  const dst = lin3([0x30, 0x20, 0x10]);
  const src = lin3([0x80, 0x80, 0x80]);
  const coverage = (value, d, s) => {
    const span = s - d;
    return Math.abs(span) < 1e-3 ? null : Math.min(1, Math.max(0, (value - d) / span));
  };
  let checked = 0;
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 40; x++) {
      for (const [label, get] of [["native", (img) => img.native(x, y)], ["browser", (img) => img.browser(x, y)]]) {
        const normalPx = get(normal);
        const lighterPx = get(lighter);
        const a = [0, 1, 2].map((c) => coverage(lin(normalPx[c] / 255), dst[c], src[c]));
        if (a.some((v) => v === null)) continue;
        const alpha = a[1];
        if (alpha < 0.95) continue;
        checked++;
        const want = [0, 1, 2].map((c) => 255 * enc(dst[c] + src[c] * alpha));
        assert.ok(dist(lighterPx, want) <= TOLERANCE, `${label} ${x},${y} ${lighterPx} vs ${want}`);
      }
    }
  assert.ok(checked > 0, "the glyph must have near-full coverage pixels to check");
});

// Blend on a non-leaf is rejected on both backends with the same leaf-set message.
const NON_LEAF = /blend applies to rect, circle, path, text, image and video leaves only/;
const REJECTS = [
  ["screen is deferred", [{ type: "rect", x: 0, y: 0, width: 2, height: 2, color: "#fff", blend: "screen" }], /Unsupported blend mode "screen"/],
  ["multiply is deferred", [{ type: "rect", x: 0, y: 0, width: 2, height: 2, color: "#fff", blend: "multiply" }], /Unsupported blend mode "multiply"/],
  ["capitalised value", [{ type: "rect", x: 0, y: 0, width: 2, height: 2, color: "#fff", blend: "Lighter" }], /Unsupported blend mode/],
  ["empty string", [{ type: "rect", x: 0, y: 0, width: 2, height: 2, color: "#fff", blend: "" }], /Unsupported blend mode/],
  ["numeric value", [{ type: "rect", x: 0, y: 0, width: 2, height: 2, color: "#fff", blend: 1 }], /Unsupported blend mode/],
  ["group", [{ type: "group", blend: "lighter", children: [] }], NON_LEAF],
  ["camera", [{ type: "camera", blend: "lighter", children: [] }], NON_LEAF],
  ["shader", [{ type: "shader", blend: "lighter", wgsl: "x" }], NON_LEAF],
  ["svg", [{ type: "svg", blend: "lighter", markup: "<svg xmlns='http://www.w3.org/2000/svg' width='2' height='2'><rect width='2' height='2' fill='#fff'/></svg>" }], NON_LEAF],
];

test("native rejects deferred, invalid and non-leaf blend props explicitly", NATIVE, async () => {
  for (const [label, leaves, message] of REJECTS) {
    const { root, p } = filmDir("reject", 2, 2, leaves);
    const native = await openNative(p, { size: [2, 2] });
    try {
      await assert.rejects(native.capture(0), message, label);
    } finally {
      await native.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("browser rejects deferred, invalid and non-leaf blend props explicitly", NATIVE, async () => {
  for (const [label, leaves, message] of REJECTS) {
    const { root, p } = filmDir("reject-b", 2, 2, leaves);
    const browser = await openFilm(p, { size: [2, 2], cpu: true });
    try {
      await assert.rejects(browser.capture(0, 0), message, label);
    } finally {
      await browser.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("blend null is the default, not an error", NATIVE, async () => {
  const leaves = [{ type: "rect", x: 0, y: 0, width: 2, height: 2, color: "#204060", blend: null }];
  const r = await render("null-blend", 2, 2, leaves);
  assert.ok(dist(r.native(0, 0), r.browser(0, 0)) <= TOLERANCE);
});

test("default blend is pixel-identical to the pre-change binary on a normal-only film", NATIVE, async () => {
  const base = process.env.LUCENT_BASE_BIN;
  assert.ok(base, "set LUCENT_BASE_BIN to the pre-change binary for the default-path comparison");
  const leaves = [
    { type: "rect", x: 0, y: 0, width: 40, height: 30, color: "#204060" },
    { type: "rect", x: 10, y: 5, width: 30, height: 20, color: "#ff800080" },
    { type: "circle", x: 20, y: 15, radius: 9, color: "#00c0ff" },
  ];
  const { root, p } = filmDir("default-identical", 40, 30, leaves);
  const current = await openNative(p, { size: [40, 30] });
  const cur = (await current.capture(0)).png;
  await current.close();
  const prev = process.env.LUCENT_NATIVE_BIN;
  process.env.LUCENT_NATIVE_BIN = base;
  try {
    const old = await openNative(p, { size: [40, 30] });
    try {
      assert.ok((await old.capture(0)).png.equals(cur), "default output differs from base binary");
    } finally {
      await old.close();
    }
  } finally {
    if (prev === undefined) delete process.env.LUCENT_NATIVE_BIN;
    else process.env.LUCENT_NATIVE_BIN = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
