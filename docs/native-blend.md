# Per-leaf blend modes

A leaf (`rect`, `circle`, `path`, `text`, `image`, `video`, `svg`) may set `blend`:

| Value      | Meaning                                                                 | Capability     |
| ---------- | ----------------------------------------------------------------------- | -------------- |
| `"normal"` | Premultiplied source-over (the default; omitting `blend` is identical)  | always         |
| `"lighter"`| Additive in linear light: `dst' = dst + src`, destination alpha kept    | `blend-lighter`|

Any other value is an error on both backends: `Unsupported blend mode <value>; native
supports normal and lighter` (the browser message names the browser set). Scenes that use
`lighter` declare `requires: ["blend-lighter"]`; the capability is advertised by the native
renderer and the browser adapter.

## Scope

- `blend` is a leaf property. Setting it on a `group`, `camera` or `shader` node is an
  error (`blend applies to leaf nodes only`). Group compositing is unchanged: a group's
  `opacity` and `clip` apply to each child leaf, and each leaf blends with the frame as it
  is at that point in the tree.
- Leaves composite into the working frame in linear light, so `lighter` is a plain
  per-channel sum of linear values, then encoded. Alpha scales the source before the add.
- Destination alpha is not changed by `lighter`. The frame is opaque from its clear colour,
  so this only matters for the shader node, which reads texel alpha.

## Not supported: `screen` and `multiply`

These are rejected, not approximated. A fixed-function blend state computes
`src * Fs + dst * Fd` per channel with one factor pair per operation. Screen and multiply
need product terms of both colours (`Cs*Cd`), which no factor pair can express. Supporting
them exactly needs a shader pass that reads the destination, the same pattern as the
`shader` node. That is a separate piece of work and is not part of this change.

## Pipelines

Two render pipelines are built once from the same shader and layout: `normal`
(colour `One, OneMinusSrcAlpha`) and `lighter` (colour `One, One`, alpha `Zero, One`, so
destination alpha is kept). No pipeline is created per leaf, so the set is bounded at two.

## Verification

`tests/blend.test.mjs` renders each fixture natively and in Chromium (`cpu: true`) and
requires byte-identical repeats. It checks overlap, partial alpha, group opacity and clip,
the default path against the pre-change binary (`LUCENT_BASE_BIN`), and every rejection on
both backends. Run with `FILM_NATIVE=1 LUCENT_BASE_BIN=<pre-change binary> node --test
tests/blend.test.mjs`.
