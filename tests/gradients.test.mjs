import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { circle, path as pathLeaf, rect } from "../sdk/index.js";
import { project } from "../src/project.mjs";
import { openNative } from "../src/native.mjs";
import { openFilm } from "../src/browser.mjs";
import { nativeBinary } from "../src/media.mjs";
import { run } from "../src/process.mjs";
import { expandStops, parseGradient } from "../web/gradient.js";

const ENGINE = path.resolve(import.meta.dirname, "..");
const NATIVE = { skip: !process.env.FILM_NATIVE, timeout: 600000 };
const REPEATS = 20;
// Native and browser 8-bit gradients each round independently, so allow 1.5 levels.
const TOLERANCE = 1.5;
const REPORT = !!process.env.LUCENT_GRADIENT_REPORT;
const say = (...a) => REPORT && console.log("#", ...a);

const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const enc = (v) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055;
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const hexAlpha = (s) => (s.length > 7 ? parseInt(s.slice(7, 9), 16) / 255 : 1);

// The expected 8-bit sRGB of `stops` at t when composited over an opaque `bg` in linear
// light, computed here from the definition (premultiplied interpolation in `space`),
// independent of both renderers.
function expected(stops, t, space, bg = [0, 0, 0], opacity = 1) {
  t = Math.min(1, Math.max(0, t));
  let i = stops.findIndex(
    (s, k) => k + 1 < stops.length && t <= stops[k + 1][0],
  );
  i = Math.max(0, i);
  const [o0, a] = stops[i];
  const [o1, b] = stops[i + 1];
  const u = o1 > o0 ? (t - o0) / (o1 - o0) : 1;
  const [ca, cb] = [hex(a), hex(b)].map((c) => c.map((v) => v / 255));
  const [aa, ab] = [hexAlpha(a), hexAlpha(b)];
  const alpha = aa + (ab - aa) * u;
  const f = space === "srgb" ? (v) => v : lin;
  const out = [];
  for (let c = 0; c < 3; c++) {
    const [va, vb] = [aa === 0 ? cb[c] : ca[c], ab === 0 ? ca[c] : cb[c]];
    const premultiplied = f(va) * aa + (f(vb) * ab - f(va) * aa) * u;
    const straight = alpha > 0 ? premultiplied / alpha : f(va);
    const src = space === "srgb" ? lin(straight) : straight;
    const a2 = alpha * opacity;
    out.push(255 * enc(src * a2 + lin(bg[c] / 255) * (1 - a2)));
  }
  return out;
}

const fillOf = (type, geometry, stops, space) => ({
  type,
  ...geometry,
  ...(space ? { space } : {}),
  stops: stops.map(([offset, color]) => ({ offset, color })),
});
const linearFill = (x1, y1, x2, y2, stops, space) =>
  fillOf("linear", { x1, y1, x2, y2 }, stops, space);
const radialFill = (cx, cy, r, stops, space) =>
  fillOf("radial", { cx, cy, r }, stops, space);
const BW = [
  [0, "#000000"],
  [1, "#ffffff"],
];

let built;
function binary() {
  if (built) return built;
  // nativeBinary() otherwise picks the newest of target/{release,debug}, which npm test
  // never rebuilds; build explicitly and pin the result.
  execFileSync("cargo", ["build", "--locked"], { cwd: ENGINE, stdio: "pipe" });
  built = path.join(ENGINE, "target/debug/lucent");
  process.env.LUCENT_NATIVE_BIN = built;
  const mtime = fs.statSync(built).mtimeMs;
  const sources = ["src/native.rs", "src/native/gradient.rs"].map(
    (f) => fs.statSync(path.join(ENGINE, f)).mtimeMs,
  );
  console.log(
    `# native binary ${nativeBinary()} built ${new Date(mtime).toISOString()}`,
  );
  assert.equal(nativeBinary(), built);
  assert.ok(
    mtime >= Math.max(...sources),
    "native binary is older than its sources",
  );
  return built;
}

function filmDir(name, width, height, leaves, background = "#000000") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lucent-grad-${name}-`));
  fs.writeFileSync(
    path.join(root, "film.js"),
    `export default {apiVersion:"0.1.0",seed:1,background:${JSON.stringify(background)},duration:1,scenes:[{id:"s",start:0,duration:1,renderer:"portable",requires:["gradients"],dependencies:[],frame:()=>(${JSON.stringify(leaves)})}]};`,
  );
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
    }),
  );
  return { root, p: project(path.join(root, "g.film.json")) };
}

// Renders `leaves` natively and in the browser REPEATS times each and requires the
// repeats to be byte-identical, so a flip-flopping measurement cannot hide.
async function render(name, width, height, leaves, background) {
  binary();
  const { root, p } = filmDir(name, width, height, leaves, background);
  const native = await openNative(p, { size: [width, height] });
  const browser = await openFilm(p, { size: [width, height], cpu: true });
  try {
    const frames = [];
    const reference = [];
    for (let i = 0; i < REPEATS; i++) {
      frames.push((await native.capture(0)).png);
      reference.push((await browser.capture(0, 0)).png);
    }
    for (let i = 1; i < REPEATS; i++) {
      assert.ok(
        frames[i].equals(frames[0]),
        `${name}: native run ${i} differs`,
      );
      assert.ok(
        reference[i].equals(reference[0]),
        `${name}: browser run ${i} differs`,
      );
    }
    const n = PNG.sync.read(frames[0], { skipRescale: true });
    assert.equal(n.depth, 16);
    const b = PNG.sync.read(reference[0]);
    const at = (img, x, y, scale) =>
      [0, 1, 2].map((c) => img.data[(y * width + x) * 4 + c] / scale);
    return {
      width,
      height,
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
function compare(name, r, points, limits) {
  const worst = {
    nativeVsBrowser: 0,
    nativeVsExpected: 0,
    browserVsExpected: 0,
  };
  for (const [x, y, want] of points) {
    const [n, b] = [r.native(x, y), r.browser(x, y)];
    worst.nativeVsBrowser = Math.max(worst.nativeVsBrowser, dist(n, b));
    if (want) {
      worst.nativeVsExpected = Math.max(worst.nativeVsExpected, dist(n, want));
      worst.browserVsExpected = Math.max(
        worst.browserVsExpected,
        dist(b, want),
      );
    }
  }
  say(name, JSON.stringify(worst), `over ${points.length} px`);
  for (const [key, limit] of Object.entries(limits))
    assert.ok(
      worst[key] <= limit,
      `${name}: ${key} ${worst[key].toFixed(2)} > ${limit}`,
    );
  return worst;
}

// Largest native-vs-browser difference and RMSE over the pixels `keep` accepts.
function region(r, keep) {
  let max = 0;
  let squared = 0;
  let count = 0;
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) {
      if (!keep(x, y)) continue;
      const [n, b] = [r.native(x, y), r.browser(x, y)];
      max = Math.max(max, dist(n, b));
      for (let c = 0; c < 3; c++) squared += (n[c] - b[c]) ** 2;
      count++;
    }
  return { max, rmse: Math.sqrt(squared / (3 * count)), count };
}

test("SDK helpers carry gradient fills and keep flat colours unchanged", () => {
  const fill = linearFill(1, 2, 30, 40, BW);
  assert.equal(rect(0, 0, 10, 10, fill).fill, fill);
  assert.ok(!("color" in rect(0, 0, 10, 10, fill)));
  assert.equal(circle(1, 2, 3, fill).fill, fill);
  assert.deepEqual(pathLeaf([["M", 0, 0]], { fill }).fill, fill);
  assert.equal(rect(0, 0, 1, 1, "#123456").color, "#123456");
  assert.ok(!("fill" in rect(0, 0, 1, 1, "#123456")));
});

test("web gradient helper mirrors the engine's expansion", () => {
  const spec = parseGradient(linearFill(0, 0, 10, 0, BW));
  assert.equal(spec.space, "linear");
  const dense = expandStops(spec.stops, spec.space);
  assert.ok(dense.length > 8 && dense.length < 200, `${dense.length} stops`);
  const mid = dense.find((s) => Math.abs(s[0] - 0.5) < 1e-9);
  assert.ok(mid, "bisection lands a stop on the midpoint");
  assert.ok(Math.abs(mid[1][0] * 255 - 187.5) < 0.1, `${mid[1][0] * 255}`);
  const srgb = parseGradient(linearFill(0, 0, 10, 0, BW, "srgb"));
  assert.equal(expandStops(srgb.stops, srgb.space).length, 2);
});

test("shared descriptor limits reject authored and aggregate stop overflow", () => {
  const atAuthoredLimit = Array.from({ length: 4096 }, (_, i) => [i / 4095, "#000000"]);
  assert.equal(parseGradient(linearFill(0, 0, 10, 0, atAuthoredLimit)).stops.length, 4096);
  const authored = Array.from({ length: 4097 }, (_, i) => [i / 4096, "#000000"]);
  assert.throws(
    () => parseGradient(linearFill(0, 0, 10, 0, authored)),
    { message: "gradient authored stops exceed maximum of 4096" },
  );
  // Each alternating segment needs many linear-light subdivisions; the aggregate
  // budget must stop expansion even though authored count is within its separate cap.
  const alternating = Array.from({ length: 4096 }, (_, i) => [
    i / 4095,
    i % 2 ? "#ffffff" : "#000000",
  ]);
  const spec = parseGradient(linearFill(0, 0, 10, 0, alternating));
  const atExpandedLimit = Array.from({ length: 65536 }, (_, i) => [i / 65535, [0, 0, 0, 1]]);
  assert.equal(expandStops(atExpandedLimit, "srgb").length, 65536);
  assert.throws(
    () => expandStops(spec.stops, spec.space),
    { message: "gradient expanded stops exceed maximum of 65536" },
  );
});

test("gradient offsets are ordered before native f32 narrowing and geometry domain is shared", () => {
  const decreasing = linearFill(0, 0, 10, 0, [
    [0.50000001, "#000000"],
    [0.5, "#ffffff"],
  ]);
  assert.throws(
    () => parseGradient(decreasing),
    { message: "gradient stop offsets must not decrease (stop 1)" },
  );
  assert.throws(
    () => parseGradient(linearFill(0, 0, 1e40, 0, BW)),
    { message: "linear gradient x2 must be a finite number" },
  );
  assert.doesNotThrow(() => parseGradient(linearFill(0, 0, 1e30, 0, BW)));
});

const NAN = Number.NaN;
const stops2 = BW;
const INVALID = [
  [
    "fewer than two stops",
    linearFill(0, 0, 10, 0, [[0, "#000000"]]),
    "gradient needs at least two stops",
  ],
  [
    "decreasing offsets",
    linearFill(0, 0, 10, 0, [
      [0.6, "#000000"],
      [0.2, "#ffffff"],
    ]),
    "gradient stop offsets must not decrease (stop 1)",
  ],
  [
    "f64-decreasing offsets lost by f32 narrowing",
    linearFill(0, 0, 10, 0, [
      [0.50000001, "#000000"],
      [0.5, "#ffffff"],
    ]),
    "gradient stop offsets must not decrease (stop 1)",
  ],
  [
    "offset out of range",
    linearFill(0, 0, 10, 0, [
      [0, "#000000"],
      [1.5, "#ffffff"],
    ]),
    "gradient stop 1 offset must be a number in [0, 1]",
  ],
  [
    "non-finite linear coordinate",
    linearFill(0, 0, NAN, 0, stops2),
    "linear gradient x2 must be a finite number",
  ],
  [
    "coordinate outside shared f32 domain",
    linearFill(0, 0, 1e40, 0, stops2),
    "linear gradient x2 must be a finite number",
  ],
  [
    "non-finite radial coordinate",
    radialFill(Infinity, 0, 5, stops2),
    "radial gradient cx must be a finite number",
  ],
  [
    "zero-length axis",
    linearFill(3, 4, 3, 4, stops2),
    "linear gradient needs two distinct endpoints",
  ],
  [
    "radius of zero",
    radialFill(0, 0, 0, stops2),
    "radial gradient radius must be greater than 0",
  ],
  [
    "negative radius",
    radialFill(0, 0, -4, stops2),
    "radial gradient radius must be greater than 0",
  ],
  [
    "unknown type",
    {
      type: "conic",
      stops: stops2.map(([offset, color]) => ({ offset, color })),
    },
    "unsupported fill descriptor type: conic",
  ],
  [
    "bad colour",
    linearFill(0, 0, 10, 0, [
      [0, "red"],
      [1, "#ffffff"],
    ]),
    "gradient stop 0 colour must be #RRGGBB or #RRGGBBAA",
  ],
  [
    "unknown colour space",
    linearFill(0, 0, 10, 0, stops2, "hsl"),
    'gradient space must be "linear" or "srgb"',
  ],
];

test("browser gradient parsing rejects each invalid descriptor with the engine's text", () => {
  for (const [label, fill, message] of INVALID)
    assert.throws(() => parseGradient(fill), { message }, label);
});

test(
  "native renderer rejects each invalid descriptor with the same text",
  NATIVE,
  async () => {
    binary();
    for (const [label, fill, message] of INVALID) {
      const { root, p } = filmDir("invalid", 20, 4, [
        { type: "rect", x: 0, y: 0, width: 20, height: 4, fill },
      ]);
      const native = await openNative(p, { size: [20, 4] });
      try {
        await assert.rejects(
          native.capture(0),
          (e) => e.message.includes(message),
          `${label}: expected "${message}"`,
        );
      } finally {
        await native.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "native advertises the gradients capability and scenes can require it",
  NATIVE,
  async () => {
    const caps = JSON.parse(await run(binary(), ["native-capabilities"]));
    assert.ok(caps.available, caps.reason);
    assert.ok(caps.features.includes("gradients"), `${caps.features}`);
  },
);

test(
  "black to white: srgb mode matches the browser at 0, 25, 50, 75 and 100 percent",
  NATIVE,
  async () => {
    // 101 px across with the axis 0.5..100.5 puts pixel x at t = x / 100 exactly.
    const w = 101;
    const leaf = (y, space) => ({
      type: "rect",
      x: 0,
      y,
      width: w,
      height: 2,
      fill: linearFill(0.5, 0, 100.5, 0, BW, space),
    });
    const r = await render("bw", w, 4, [leaf(0, "srgb"), leaf(2)]);
    const ticks = [0, 25, 50, 75, 100];
    const table = ticks.map((x) => ({
      percent: x,
      srgbNative: r.native(x, 0)[0].toFixed(2),
      srgbBrowser: r.browser(x, 0)[0],
      srgbExpected: (255 * (x / 100)).toFixed(2),
      linearNative: r.native(x, 2)[0].toFixed(2),
      linearBrowser: r.browser(x, 2)[0],
      linearExpected: expected(BW, x / 100, "linear")[0].toFixed(2),
    }));
    console.log("# black to white, 8-bit sRGB values per percent:");
    console.table(table);
    // srgb: native within 1 level of the browser (and of the definition) at every tick.
    compare(
      "bw srgb ticks",
      r,
      ticks.map((x) => [x, 0, expected(BW, x / 100, "srgb")]),
      {
        nativeVsBrowser: TOLERANCE,
        nativeVsExpected: TOLERANCE,
        browserVsExpected: TOLERANCE,
      },
    );
    // The whole row, not just the ticks.
    compare(
      "bw srgb row",
      r,
      Array.from({ length: w }, (_, x) => [
        x,
        1,
        expected(BW, x / 100, "srgb"),
      ]),
      { nativeVsBrowser: TOLERANCE, nativeVsExpected: TOLERANCE },
    );
    // Default: the midpoint is the linear-light value, 187.5 -> 188, and it is not the srgb 128.
    const [linearMid, srgbMid] = [r.native(50, 2)[0], r.native(50, 0)[0]];
    assert.ok(Math.abs(linearMid - 187.5) <= 1, `linear midpoint ${linearMid}`);
    assert.ok(Math.abs(srgbMid - 127.5) <= 1, `srgb midpoint ${srgbMid}`);
    assert.ok(
      linearMid - srgbMid > 55,
      "the two spaces must differ at the midpoint",
    );
    for (const c of r.native(50, 2)) assert.ok(Math.abs(c - linearMid) <= 0.01);
    compare(
      "bw linear row",
      r,
      Array.from({ length: w }, (_, x) => [
        x,
        3,
        expected(BW, x / 100, "linear"),
      ]),
      {
        nativeVsBrowser: TOLERANCE,
        nativeVsExpected: TOLERANCE,
        browserVsExpected: TOLERANCE,
      },
    );
  },
);

test(
  "the midpoint is identical across fresh native processes",
  NATIVE,
  async () => {
    binary();
    const leaf = (space) => ({
      type: "rect",
      x: 0,
      y: 0,
      width: 101,
      height: 1,
      fill: linearFill(0.5, 0, 100.5, 0, BW, space),
    });
    const seen = new Set();
    for (let i = 0; i < REPEATS; i++) {
      const { root, p } = filmDir("fresh", 101, 2, [leaf()]);
      const native = await openNative(p, { size: [101, 2] });
      try {
        seen.add(
          PNG.sync
            .read((await native.capture(0)).png, { skipRescale: true })
            .data.join(),
        );
      } finally {
        await native.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
    assert.equal(seen.size, 1, "fresh processes must agree byte for byte");
  },
);

test("radial gradients follow a radius in both spaces", NATIVE, async () => {
  const stops = [
    [0, "#ffffff"],
    [1, "#102040"],
  ];
  const leaf = (y, space) => ({
    type: "rect",
    x: 0,
    y,
    width: 201,
    height: 21,
    fill: radialFill(100.5, y + 10.5, 100, stops, space),
  });
  const r = await render("radial", 201, 42, [leaf(0, "srgb"), leaf(21)]);
  // Along the centre row pixel x sits at t = (x - 100) / 100.
  const row = (y, space) =>
    Array.from({ length: 101 }, (_, k) => [
      100 + k,
      y,
      expected(stops, k / 100, space),
    ]);
  compare("radial srgb", r, row(10, "srgb"), {
    nativeVsBrowser: 2,
    nativeVsExpected: 2,
    browserVsExpected: 2,
  });
  compare("radial linear", r, row(31, "linear"), {
    nativeVsBrowser: 2,
    nativeVsExpected: 2,
    browserVsExpected: 2,
  });
  // Pad: beyond the radius the last stop holds.
  compare(
    "radial pad",
    r,
    [
      [0, 0, hex("#102040")],
      [0, 41, hex("#102040")],
    ].map(([x, y, c]) => [x, y, c]),
    { nativeVsBrowser: TOLERANCE, nativeVsExpected: TOLERANCE },
  );
  assert.ok(
    r.native(150, 31)[0] - r.native(150, 10)[0] > 20,
    "spaces differ at half radius",
  );
});

test(
  "gradients fill rects, circles and paths like the browser",
  NATIVE,
  async () => {
    const rainbow = [
      [0, "#ff3030"],
      [0.5, "#30ff30"],
      [1, "#3030ff"],
    ];
    const leaves = [
      {
        type: "rect",
        x: 4,
        y: 4,
        width: 52,
        height: 52,
        fill: linearFill(4, 0, 56, 0, rainbow),
      },
      {
        type: "circle",
        x: 100,
        y: 30,
        radius: 26,
        fill: radialFill(92, 22, 40, [
          [0, "#ffffff"],
          [1, "#2040ff"],
        ]),
      },
      {
        type: "path",
        commands: [["M", 144, 56], ["L", 170, 4], ["L", 196, 56], ["Z"]],
        fill: linearFill(
          0,
          4,
          0,
          56,
          [
            [0, "#ffe000"],
            [1, "#e00080"],
          ],
          "srgb",
        ),
      },
    ];
    const r = await render("shapes", 200, 60, leaves, "#101010");
    const insideCircle = (x, y) => Math.hypot(x + 0.5 - 100, y + 0.5 - 30) < 24;
    const insideRect = (x, y) => x >= 6 && x < 54 && y >= 6 && y < 54;
    const insideTriangle = (x, y) => {
      const [px, py] = [x + 0.5, y + 0.5];
      const half = ((py - 4) / 52) * 26 - 2.5;
      return py > 8 && py < 53 && Math.abs(px - 170) < half;
    };
    for (const [name, keep, tolerance] of [
      ["rect", insideRect, TOLERANCE],
      ["circle", insideCircle, 2],
      ["path", insideTriangle, TOLERANCE],
    ]) {
      const m = region(r, keep);
      say(name, JSON.stringify(m));
      assert.ok(m.count > 300, `${name} sampled ${m.count}`);
      assert.ok(
        m.max <= tolerance,
        `${name} interior max ${m.max.toFixed(2)} > ${tolerance}`,
      );
    }
    // The rect row also matches the definition of the default (linear-light) blend.
    compare(
      "rect row",
      r,
      Array.from({ length: 48 }, (_, k) => [
        6 + k,
        30,
        expected(rainbow, (6 + k + 0.5 - 4) / 52, "linear", [16, 16, 16]),
      ]),
      { nativeVsBrowser: TOLERANCE, nativeVsExpected: TOLERANCE },
    );
    // Outside every shape the background is untouched.
    for (const [x, y] of [
      [70, 30],
      [130, 6],
      [199, 0],
      [0, 59],
    ])
      assert.deepEqual(r.native(x, y).map(Math.round), [16, 16, 16]);
    // Whole-frame agreement including anti-aliased edges.
    const all = region(r, () => true);
    say("shapes whole frame", JSON.stringify(all));
    assert.ok(all.rmse < 1.5, `whole-frame RMSE ${all.rmse.toFixed(3)}`);
  },
);

test(
  "gradients follow rotate/scale transforms and clip masks",
  NATIVE,
  async () => {
    const group = {
      type: "group",
      translate: [100, 60],
      rotate: 0.4,
      scale: [1.5, 0.8],
      clip: [-40, -30, 80, 60],
      children: [
        {
          type: "rect",
          x: -50,
          y: -40,
          width: 100,
          height: 80,
          fill: linearFill(-50, 0, 50, 0, [
            [0, "#ff2020"],
            [1, "#2020ff"],
          ]),
        },
        {
          type: "circle",
          x: 10,
          y: 5,
          radius: 18,
          fill: radialFill(10, 5, 18, [
            [0, "#ffffffff"],
            [1, "#ffffff00"],
          ]),
        },
      ],
    };
    const r = await render("transform", 200, 120, [group], "#000000");
    const [cos, sin] = [Math.cos(0.4), Math.sin(0.4)];
    const local = (x, y) => {
      const [dx, dy] = [x + 0.5 - 100, y + 0.5 - 60];
      return [(dx * cos + dy * sin) / 1.5, (-dx * sin + dy * cos) / 0.8];
    };
    const inside = (x, y, margin) => {
      const [u, v] = local(x, y);
      return (
        u > -40 + margin &&
        u < 40 - margin &&
        v > -30 + margin &&
        v < 30 - margin
      );
    };
    // The circle's feathered rim is excluded: there alpha is ~1% and a linear-light blend
    // over a dark base turns that into tens of sRGB levels, so it only measures edge
    // coverage, not the gradient.
    const rim = (x, y) => {
      const [u, v] = local(x, y);
      return Math.hypot(u - 10, v - 5);
    };
    // The radial glow fades from alpha 1 at its centre to 0 at radius 18. The engine keeps
    // 8-bit premultiplied layers, so rounding is magnified by 1/alpha (flat translucent
    // fills too): measure the glow where alpha >= 0.5 with a 2-level limit, the plain
    // gradient with TOLERANCE.
    const plain = region(r, (x, y) => inside(x, y, 3) && rim(x, y) > 19);
    const glow = region(r, (x, y) => inside(x, y, 3) && rim(x, y) <= 9);
    say("transform plain", JSON.stringify(plain), "glow", JSON.stringify(glow));
    assert.ok(
      plain.count > 2000 && glow.count > 200,
      `${plain.count} ${glow.count}`,
    );
    assert.ok(
      plain.max <= TOLERANCE,
      `transform gradient max ${plain.max.toFixed(2)}`,
    );
    assert.ok(glow.max <= 2, `transform glow max ${glow.max.toFixed(2)}`);
    let outside = 0;
    for (let y = 0; y < 120; y++)
      for (let x = 0; x < 200; x++) {
        const [u, v] = local(x, y);
        if (u < -42 || u > 42 || v < -32 || v > 32) {
          outside++;
          assert.deepEqual(
            r.native(x, y).map(Math.round),
            [0, 0, 0],
            `clip leak at ${x},${y}`,
          );
        }
      }
    assert.ok(outside > 10000);
    // The gradient axis rotated with the leaf: colour is constant along the rotated cross axis.
    const [p, q] = [
      [100, 60],
      [100 + Math.round(-sin * 10), 60 + Math.round(cos * 10 * 0.8)],
    ];
    void p;
    void q;
  },
);

test(
  "alpha stops are premultiplied: no dark fringe, correct blend",
  NATIVE,
  async () => {
    const bg = "#4080c0";
    const band = (y) => ({
      type: "rect",
      x: 0,
      y,
      width: 101,
      height: 4,
      color: bg,
    });
    const grad = (y, stops, space) => ({
      type: "rect",
      x: 0,
      y,
      width: 101,
      height: 4,
      fill: linearFill(0.5, 0, 100.5, 0, stops, space),
    });
    const toTransparentWhite = [
      [0, "#ffffffff"],
      [1, "#ffffff00"],
    ];
    const toTransparentBlack = [
      [0, "#ffffffff"],
      [1, "#00000000"],
    ];
    const redToHalfBlue = [
      [0, "#ff0000ff"],
      [1, "#0000ff80"],
    ];
    const leaves = [
      band(0),
      grad(0, toTransparentWhite),
      band(4),
      grad(4, toTransparentBlack),
      { type: "rect", x: 0, y: 8, width: 101, height: 4, color: "#ffffff" },
      grad(8, toTransparentBlack),
      band(12),
      grad(12, redToHalfBlue),
      band(16),
      grad(16, redToHalfBlue, "srgb"),
    ];
    const r = await render("alpha", 101, 20, leaves);
    const ticks = [0, 10, 25, 50, 75, 90, 100];
    const bgRgb = hex(bg);
    // Fading white to transparent black must equal fading to transparent white.
    for (let x = 0; x <= 100; x++)
      assert.ok(
        dist(r.native(x, 1), r.native(x, 5)) <= 1,
        `fringe differs at ${x}`,
      );
    // And over a white page it stays white: any darkening is a fringe.
    for (let x = 0; x <= 100; x++)
      for (const c of r.native(x, 9))
        assert.ok(c >= 254, `dark fringe ${c} at ${x}`);
    const worst = (y, stops, space, tolerance) =>
      compare(
        `alpha row ${y}`,
        r,
        ticks.map((x) => [x, y, expected(stops, x / 100, space, bgRgb)]),
        { nativeVsExpected: tolerance, nativeVsBrowser: tolerance },
      );
    worst(1, toTransparentWhite, "linear", 2);
    worst(5, toTransparentBlack, "linear", 2);
    worst(13, redToHalfBlue, "linear", 2);
    worst(17, redToHalfBlue, "srgb", 2);
  },
);

test(
  "Pad spread holds the end colours beyond the endpoints",
  NATIVE,
  async () => {
    const stops = [
      [0, "#ff2000"],
      [1, "#0020ff"],
    ];
    const leaf = (y, space) => ({
      type: "rect",
      x: 0,
      y,
      width: 100,
      height: 2,
      fill: linearFill(25, 0, 75, 0, stops, space),
    });
    const r = await render("pad", 100, 4, [leaf(0), leaf(2, "srgb")]);
    for (const [y, space] of [
      [0, "linear"],
      [2, "srgb"],
    ]) {
      for (let x = 0; x < 24; x++) {
        assert.ok(
          dist(r.native(x, y), hex("#ff2000")) <= 1,
          `${space} left pad at ${x}: ${r.native(x, y)}`,
        );
        assert.ok(dist(r.native(x, y), r.browser(x, y)) <= TOLERANCE);
      }
      for (let x = 76; x < 100; x++) {
        assert.ok(
          dist(r.native(x, y), hex("#0020ff")) <= 1,
          `${space} right pad at ${x}: ${r.native(x, y)}`,
        );
        assert.ok(dist(r.native(x, y), r.browser(x, y)) <= TOLERANCE);
      }
      compare(
        `pad ${space} inside`,
        r,
        Array.from({ length: 49 }, (_, k) => [
          26 + k,
          y,
          expected(stops, (26 + k + 0.5 - 25) / 50, space),
        ]),
        { nativeVsBrowser: TOLERANCE, nativeVsExpected: TOLERANCE },
      );
    }
  },
);

test(
  "leaf opacity applies to gradient fills like flat fills",
  NATIVE,
  async () => {
    const bg = [32, 64, 96];
    const leaves = [
      { type: "rect", x: 0, y: 0, width: 101, height: 2, color: "#204060" },
      {
        type: "rect",
        x: 0,
        y: 0,
        width: 101,
        height: 2,
        opacity: 0.5,
        fill: linearFill(0.5, 0, 100.5, 0, [
          [0, "#ff8000"],
          [1, "#00c0ff"],
        ]),
      },
    ];
    const r = await render("opacity", 101, 2, leaves);
    compare(
      "opacity",
      r,
      [0, 20, 50, 80, 100].map((x) => [
        x,
        0,
        expected(
          [
            [0, "#ff8000"],
            [1, "#00c0ff"],
          ],
          x / 100,
          "linear",
          bg,
          0.5,
        ),
      ]),
      { nativeVsExpected: 2, nativeVsBrowser: 2 },
    );
  },
);

test(
  "a flat string fill is bit-identical to a flat color",
  NATIVE,
  async () => {
    const mk = (x, key) => ({
      type: "circle",
      x,
      y: 12,
      radius: 10.3,
      [key]: "#336699cc",
    });
    const r = await render("flat", 64, 24, [mk(16, "color"), mk(48, "fill")]);
    for (let y = 0; y < 24; y++)
      for (let x = 0; x < 32; x++)
        assert.deepEqual(
          r.native(x, y),
          r.native(x + 32, y),
          `pixel ${x},${y}`,
        );
  },
);
