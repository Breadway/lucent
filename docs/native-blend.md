# Per-leaf blend modes

A leaf (`rect`, `circle`, `path`, `text`, `image`, `video`) may set `blend`. The `svg` leaf
is native-only and does not accept `blend` on either backend (see Scope):

| Value      | Meaning                                                                 | Capability     |
| ---------- | ----------------------------------------------------------------------- | -------------- |
| `"normal"` | Premultiplied source-over (the default; omitting `blend` is identical)  | always         |
| `"lighter"`| Additive in linear light: `dst' = dst + src`, destination alpha kept    | `blend-lighter`|

Any other value is an error on both backends: `Unsupported blend mode <value>; native
supports normal and lighter` (the browser message names the browser set). Scenes that use
`lighter` declare `requires: ["blend-lighter"]`; the capability is advertised by the native
renderer and the browser adapter.

## Scope

- `blend` is set on the drawable leaves listed above. Setting it on a `group`, `camera`,
  `shader` or `svg` node is an error (`blend applies to rect, circle, path, text, image and
  video leaves only`), on both backends. Group compositing is unchanged: a group's
  `opacity` and `clip` apply to each child leaf, and each leaf blends with the frame as it
  is at that point in the tree.
- Leaves composite into the working frame in linear light, so `lighter` is a plain
  per-channel sum of linear values, then encoded. Alpha scales the source before the add.
- Destination alpha is not changed by `lighter`. The frame is opaque from its clear colour,
  so this only matters for the shader node, which reads texel alpha.

## Deferred: `screen` and `multiply`

These are rejected with `Unsupported blend mode`. They are deferred scope, not impossible
on the GPU. The card's first scope is additive, and these two are left for a follow-up.

A fixed-function blend state computes `src * Fs + dst * Fd` per channel with one factor
pair per operation (wgpu `BlendFactor` provides `Dst`, `OneMinusSrc` and related factors).
Against the W3C premultiplied formulas:

- `screen` is exact for any destination with colour `(One, OneMinusSrc)` and alpha
  `(One, OneMinusSrcAlpha)`.
- `multiply` is exact when the destination is opaque, with colour `(Dst, OneMinusSrcAlpha)`
  and alpha `(One, OneMinusSrcAlpha)`. For a translucent destination it needs an extra
  `Cs * (1 - ab)` term that the fixed factors cannot form, so it would then need a
  destination-reading pass.

The normal pipeline's destination is always opaque, so `multiply` is representable there.
Adding the two modes is a separate change: two more closed pipelines, fixtures against the
W3C formulas, and an explicit decision about translucent destinations.

## Transparent destination alpha

`lighter` keeps destination alpha, so on a translucent destination it differs from Canvas
`lighter` (which sums alpha, giving 1.0 from 0.5 plus 0.5). The frame is cleared to alpha 1
on both backends and output alpha is forced to 1, so this is unobservable in film output.
It is only visible to a user `shader` node that reads texel alpha. The intended contract is
an opaque frame. The fixtures test this contract on native (a shader node writes alpha 0.5
and the lighter leaf must leave it at 0.5) and document the Canvas divergence rather than
claim the two match.

## Rendering paths

`cpu: true` in the test harness passes `--disable-gpu`. Chromium still provides WebGL2 with
`EXT_color_buffer_float` through SwiftShader, so the browser fixtures exercise the WebGL
compositor path, not the JavaScript CPU path in `web/linear.js`. The JavaScript CPU path is
used only when WebGL2 or float colour buffers are unavailable, and it is checked separately
with a direct `LinearCompositor` probe.

## Pipelines

Two render pipelines are built once from the same shader and layout: `normal`
(colour `One, OneMinusSrcAlpha`) and `lighter` (colour `One, One`, alpha `Zero, One`, so
destination alpha is kept). No pipeline is created per leaf, so the set is bounded at two.

## Verification

`tests/blend.test.mjs` renders each fixture natively and in Chromium and requires
byte-identical repeats. It checks:

- overlap, partial alpha, group opacity and group clip against the linear-light definition
- a `lighter` text leaf, by recovering glyph coverage from each backend's own normal render
  (native and browser text rasterise edges differently, so text is not compared across
  backends)
- translucent destination alpha on native, with a documented divergence from Canvas
- every rejection on both backends: `screen`, `multiply`, invalid values, and blend on
  group, camera, shader and svg nodes
- `blend: null` as the default
- the default path against the pre-change binary (`LUCENT_BASE_BIN`)

`tests/blend-compositor.test.mjs` runs the JavaScript CPU branch of `web/linear.js` by
making WebGL2 unavailable, since the browser fixtures use the WebGL path.

Run with `FILM_NATIVE=1 LUCENT_BASE_BIN=<pre-change binary> node --test tests/blend.test.mjs`
and `node --test tests/blend-compositor.test.mjs`.
