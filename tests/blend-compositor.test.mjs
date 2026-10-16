import test from "node:test";
import assert from "node:assert/strict";

// Drives web/linear.js LinearCompositor's JavaScript CPU branch directly by making
// getContext("webgl2") return null. This is the only test that exercises that branch;
// the browser fixtures in blend.test.mjs run the WebGL path under SwiftShader.
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);

function loadCompositor() {
  globalThis.ImageData = class {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  globalThis.document = { createElement: () => ({ getContext: () => null, width: 0, height: 0 }) };
  return import(`../web/linear.js?cpu=${Math.random()}`).then((m) => m.LinearCompositor);
}

const layer = (rgba) => ({
  getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray([...rgba, ...rgba]) }) }),
});

test("JS CPU compositor: lighter and normal match the linear-light definition", async () => {
  const LinearCompositor = await loadCompositor();
  const c = new LinearCompositor(2, 1);
  assert.equal(c.cpu, true, "the CPU branch must be active for this test");
  const bg = [0x30, 0x20, 0x10];
  const a = 128 / 255;
  let out;
  const ctx = { putImageData: (img) => (out = img.data) };

  c.begin(bg);
  c.add(layer([0x80, 0x80, 0x80, 0x80]), "lighter");
  c.finish(ctx);
  const wantLighter = bg.map((v) => 255 * enc(lin(v / 255) + lin(0x80 / 255) * a));
  for (let i = 0; i < 3; i++)
    assert.ok(Math.abs(out[i] - wantLighter[i]) <= 1, `lighter ch${i} ${out[i]} vs ${wantLighter[i]}`);

  c.begin(bg);
  c.add(layer([0x80, 0x80, 0x80, 0x80]), "normal");
  c.finish(ctx);
  const wantNormal = bg.map((v) => 255 * enc(lin(0x80 / 255) * a + lin(v / 255) * (1 - a)));
  for (let i = 0; i < 3; i++)
    assert.ok(Math.abs(out[i] - wantNormal[i]) <= 1, `normal ch${i} ${out[i]} vs ${wantNormal[i]}`);
});

test("compositor rejects unknown and non-string blend values, including null", async () => {
  const LinearCompositor = await loadCompositor();
  const c = new LinearCompositor(1, 1);
  for (const bad of ["screen", "multiply", "", "Lighter", null, 5, false]) {
    c.begin([0, 0, 0]);
    assert.throws(() => c.add(layer([1, 1, 1, 255]), bad), /Unsupported blend mode/, JSON.stringify(bad));
  }
});
