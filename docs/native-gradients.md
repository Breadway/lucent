# Native gradient fills

Native `rect`, `circle` and filled `path` leaves accept `fill` as either a flat
`#RRGGBB`/`#RRGGBBAA` string or a gradient descriptor. `rect(...)` and `circle(...)`
accept the descriptor in place of their colour argument, and `path(commands, { fill })`
takes it as a prop. A scene using gradients declares `requires: ["gradients"]`.
The browser backend renders the same descriptors, so a film stays portable.

```ts
rect(0, 0, 640, 360, {
  type: "linear", x1: 0, y1: 0, x2: 640, y2: 0,
  stops: [{ offset: 0, color: "#102040" }, { offset: 1, color: "#80c0ff" }],
});
circle(320, 180, 140, {
  type: "radial", cx: 320, cy: 180, r: 140, space: "srgb",
  stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#00000000" }],
});
```

Coordinates are in the leaf's local design space and move with its transform, clip
and opacity exactly like a flat fill. The spread mode is always Pad: beyond the
endpoints (or beyond the radius) the end colours hold. Stroked paths ignore `fill`
and use `color`.

## Colour space

`space` chooses where stops are mixed:

| `space`            | Mixing                                     | Black to white midpoint |
| ------------------ | ------------------------------------------ | ----------------------- |
| `"linear"` (default) | linear light, the space the engine composites in | sRGB 188 (187.5)  |
| `"srgb"`           | encoded sRGB values, like CSS and canvas gradients | sRGB 128 (127.5)  |

Both spaces interpolate **premultiplied** colour, so a stop with alpha 0 adds no dark
fringe, and a fully transparent stop takes its neighbour's colour (white to
`#00000000` stays white).

## How it is rendered

tiny-skia mixes stops in sRGB. For `"linear"` each segment between user stops is
subdivided by bisection until the chord (what tiny-skia mixes between the dense
stops) is within 0.25 of an 8-bit level of the true linear-light colour at the segment
midpoint, in alpha and in every premultiplied channel (at most 10 halvings). The dense
stops, converted to sRGB, replace the authored ones, and tiny-skia then paints the leaf
once. Because the whole fill is still one tiny-skia paint, anti-aliased edges, clip
masks, transforms, leaf opacity and the 8-bit premultiplied sRGB working buffer behave
exactly like a flat fill, and flat fills are untouched (bit-identical). A black to white
gradient becomes 29 stops; its worst error against the exact curve, sampled at 4001
points, is 0.24 of a level (a unit test asserts it stays under 0.4). `"srgb"` hands the stops to tiny-skia as authored.

`src/native/gradient.rs` and `web/gradient.js` implement the same expansion; the browser
backend uses it so canvas gradients agree with the native ones in both spaces.

## Validation

Both backends reject a bad descriptor with the same message:

- `gradient needs at least two stops`
- `gradient stop offsets must not decrease (stop N)`
- `gradient stop N offset must be a number in [0, 1]`
- `gradient stop N colour must be #RRGGBB or #RRGGBBAA`
- `linear gradient x2 must be a finite number` (any coordinate)
- `linear gradient needs two distinct endpoints`
- `radial gradient radius must be greater than 0`
- `unsupported fill descriptor type: conic`
- `gradient space must be "linear" or "srgb"`

## Measured against the browser

`tests/gradients.test.mjs` renders each fixture in Chromium (`openFilm`, `cpu: true`)
and natively (GPU) and compares 8-bit sRGB values. Black to white, per percent along the
axis:

| percent | srgb native / browser | linear native / browser |
| ------- | --------------------- | ----------------------- |
| 0       | 0 / 0                 | 0 / 0                   |
| 25      | 64 / 64               | 137 / 137               |
| 50      | 128 / 127             | 188 / 188               |
| 75      | 191 / 192             | 225 / 225               |
| 100     | 255 / 255             | 255 / 255               |

Native and browser agree within 1.1 levels everywhere on plain gradients (each side
rounds to 8 bits independently), and within 2 levels where a translucent fill is
blended. Every measurement is rendered 20 times in a row and must be byte-identical.
Run the suite with `FILM_NATIVE=1 node --test tests/gradients.test.mjs`; it runs
`cargo build --locked` first and sets `LUCENT_NATIVE_BIN` so a stale `target/` binary
cannot be measured.
