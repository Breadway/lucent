import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { project } from "../src/project.mjs";
import { openNative } from "../src/native.mjs";
import {
  Element,
  cssWeight,
  installDocument,
  serialize,
} from "../compat/astra/native/dom.js";

// The shim replaces Number#toLocaleString and the font bindings are host functions, so keep
// both contained to this file's process.
const toLocaleString = Number.prototype.toLocaleString;
test.after(() => {
  Number.prototype.toLocaleString = toLocaleString;
  delete globalThis.document;
  delete globalThis.__has_glyph;
  delete globalThis.__measure_text;
});

test("weights resolve to the declared faces by the CSS matching rules", () => {
  // Inter is declared at 400..800, JetBrains Mono at 400..600.
  assert.equal(cssWeight(560), 600);
  assert.equal(cssWeight(650), 700);
  assert.equal(cssWeight(450), 500);
  assert.equal(cssWeight(300), 400);
  assert.equal(cssWeight(900), 800);
  assert.equal(cssWeight(700, true), 600);
  assert.equal(cssWeight(800, true), 600);
  assert.equal(cssWeight(500), 500);
});

test("path geometry: lengths, points and arcs", () => {
  const line = new Element("path");
  line.setAttribute("d", "M0 0 L30 40");
  assert.equal(line.getTotalLength(), 50);
  assert.deepEqual(line.getPointAtLength(25), { x: 15, y: 20 });
  const circle = new Element("path");
  circle.setAttribute("d", "M0 -10 A10 10 0 1 1 0 10 A10 10 0 1 1 0 -10");
  assert.ok(Math.abs(circle.getTotalLength() - 2 * Math.PI * 10) < 0.05);
  const closed = new Element("path");
  closed.setAttribute("d", "M0 0h10v10h-10z");
  assert.equal(closed.getTotalLength(), 40);
  // the cached geometry follows later edits to `d`
  line.setAttribute("d", "M0 0 L0 7");
  assert.equal(line.getTotalLength(), 7);
});

test("serialisation applies style, hides display:none and unwraps full-bleed layers", () => {
  const doc = installDocument();
  const layer = doc.createElementNS("", "svg");
  layer.setAttribute("viewBox", "0 0 1920 1080");
  layer.setAttribute("width", 1920);
  layer.setAttribute("height", 1080);
  const shown = doc.createElementNS("", "path");
  shown.setAttribute("d", "M0 0L1 1");
  shown.style.strokeDasharray = "4 8";
  shown.style.filter = "url(#glow)";
  const hidden = doc.createElementNS("", "rect");
  hidden.style.display = "none";
  const label = doc.createElementNS("", "text");
  label.setAttribute("class", "mono");
  label.setAttribute("font-weight", 560);
  label.textContent = "a < b";
  [shown, hidden, label].forEach((c) => layer.appendChild(c));
  const out = serialize(layer).join("");
  assert.ok(out.startsWith("<g>"), "layer becomes a plain group");
  assert.match(
    out,
    /<path d="M0 0L1 1" stroke-dasharray="4 8" filter="url\(#glow\)"\/>/,
  );
  assert.doesNotMatch(out, /<rect/);
  assert.match(out, /font-family="JetBrains Mono"/);
  assert.match(
    out,
    /font-weight="600"/,
    "mono 560 resolves to the declared 600",
  );
  assert.match(out, />a &lt; b<\/text>/);
});

test("en-US number grouping is available without Intl", () => {
  installDocument();
  assert.equal((1234567).toLocaleString("en-US"), "1,234,567");
  assert.equal((999).toLocaleString("en-US"), "999");
  assert.equal(
    (1234.5).toLocaleString("en-US", { minimumFractionDigits: 2 }),
    "1,234.50",
  );
});

test("text with glyphs the page font lacks is split into positioned runs", () => {
  const doc = installDocument();
  // 10px per character; only "Liberation Sans" has the arrow.
  globalThis.__measure_text = (text) => text.length * 10;
  globalThis.__has_glyph = (family, code) =>
    family === "Liberation Sans" || code < 0x2190;
  const t = doc.createElementNS("", "text");
  for (const [k, v] of Object.entries({
    x: 100,
    y: 50,
    "text-anchor": "middle",
    "font-size": 20,
    fill: "#fff",
  }))
    t.setAttribute(k, v);
  t.textContent = "a → b";
  const out = serialize(t).join("");
  // runs "a ", "→", " b" are 20, 10 and 20 wide: centred on x=100 they start at 75
  assert.match(out, /<text x="75" y="50" font-family="Inter">a <\/text>/);
  assert.match(
    out,
    /<text x="95" y="50" font-family="Liberation Sans">→<\/text>/,
  );
  assert.match(out, /<text x="105" y="50" font-family="Inter"> b<\/text>/);
  assert.match(
    out,
    /^<g font-size="20" fill="#fff" text-anchor="start" xml:space="preserve">/,
  );
  // fully covered text is left to the renderer as one element
  t.textContent = "plain";
  assert.match(serialize(t).join(""), /^<text /);
});

test(
  "native svg node: gradient, filter, text, determinism and seeded grain",
  { skip: !process.env.FILM_NATIVE, timeout: 120000 },
  async () => {
    const p = project("examples/svg/svg.film.json"),
      native = await openNative(p, { size: [640, 360] });
    try {
      const a = PNG.sync.read((await native.capture(1)).png),
        again = PNG.sync.read((await native.capture(1)).png),
        next = PNG.sync.read((await native.capture(1.04)).png);
      assert.deepEqual(a.data, again.data, "same time, same pixels");
      const at = (img, x, y) => [
        ...img.data.subarray((y * 640 + x) * 4, (y * 640 + x) * 4 + 3),
      ];
      const left = at(a, 45, 90),
        right = at(a, 235, 90);
      assert.ok(
        left[0] > 200 && left[2] < 60,
        `gradient starts red, got ${left}`,
      );
      assert.ok(
        right[2] > 200 && right[0] < 60,
        `gradient ends blue, got ${right}`,
      );
      const bg = at(a, 600, 350);
      [0x10, 0x20, 0x30].forEach((v, i) =>
        assert.ok(Math.abs(bg[i] - v) < 12, `background ${bg}`),
      );
      let white = 0;
      for (let y = 30; y < 70; y++)
        for (let x = 320; x < 400; x++)
          if (at(a, x, y).every((c) => c > 200)) white++;
      assert.ok(white > 30, `text drew ${white} bright pixels`);
      // blur softens the circle edge: the pixel just outside r=30 is neither bg nor full green
      const edge = at(a, 100 + 40 + 33, 250);
      assert.ok(edge[1] > bg[1] + 4 && edge[1] < 250, `blurred edge ${edge}`);
      // a new frame seeds new grain: background pixels move by a few levels, not more
      assert.notDeepEqual(at(a, 600, 350), at(next, 600, 350));
    } finally {
      await native.close();
    }
  },
);
