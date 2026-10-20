# Per-leaf Gaussian blur (phase 1)

A `rect`, `circle` or `path` leaf may set `blur` to a Gaussian sigma in design px. It needs the
`blur` capability. `blur` is `0` to `128`; absent, `null` or `0` is no blur and renders exactly
as before.

## Scope

- Phase 1 covers per-leaf blur only, on rect, circle and filled or stroked path leaves.
- Rejected with an explicit error, never dropped silently: `blur` on `group`, `camera`,
  `shader`, `svg`, `text`, `image` and `video` nodes, on both backends.
- Not in phase 1: drop shadows, feathered clip masks and blur on groups. These are later phases
  of LUCENT-18 and remain open.

## Semantics

- Blur runs before the leaf's `clip`, as CSS and canvas filters order them, so a clip edge
  stays sharp and cuts the blurred halo.
- Support radius is `ceil(3 * sigma * s)` device px, where `s` is the largest axis stretch of the
  leaf's transform. The output region is the leaf's padded bounds grown by that radius and clamped
  to the frame. The source raster is the padded leaf bounds grown by the same radius and clamped
  to the frame, so offscreen leaves cost only their visible part.
- The kernel is normalised Gaussian. Intermediate and output values are premultiplied 8-bit. Each
  output channel is clamped to alpha, so the premultiplied invariant holds.
- Work is bounded per leaf: `(out*src + out*out) * taps * 4 <= 8e9`. Radius is limited to
  512 px. Violations fail with an error naming the limit.

## Validation

Native rejects non-number, negative, non-finite and above-128 values before any allocation.
The browser reference applies the same range check.

## Performance (measured, not a budget)

Release binaries, AMD Radeon 860M (RADV), one 600x400 white rect in the frame. Timed with a
short script outside the repository, calling `openNative` and `capture` directly. Median of 9 warm frames (first frame of each of 3 runs discarded).

| size      | scene   | binary        | median ms |
| --------- | ------- | ------------- | --------- |
| 1920x1080 | plain   | base (pre)    | 48        |
| 1920x1080 | plain   | head          | 48        |
| 1920x1080 | blur 4  | head          | 132       |
| 3840x2160 | plain   | base (pre)    | 159       |
| 3840x2160 | plain   | head          | 155       |
| 3840x2160 | blur 4  | head          | 214       |

Default path (no `blur` key) shows no measurable change at either size. A sigma-4 blur on one
600x400 leaf adds about 84 ms at 1080p and about 59 ms at 4K. These numbers are for one leaf on
a near-empty frame. A real scene with many blurred leaves will be slower in proportion. This is
the CPU separable path. A GPU separable pass is not measured yet and is a candidate for a later
phase if many blurred leaves are needed.

## Verification

`tests/blur.test.mjs` (requires `FILM_NATIVE=1`, and `LUCENT_BASE_BIN` for the default-path
comparison):

- symmetric edge softening and outer falloff
- halo extends beyond the leaf; clip cuts after blur
- offscreen leaf keeps its visible interior and halo
- default and `blur: 0` are byte-identical to the pre-change binary
- group, text, image and video rejection on both backends
- hostile values rejected before rendering
- native and browser agree within a bounded per-channel error

Run with `LUCENT_VERIFY_BBOX=1` as well, which checks that no pixel lands outside its region.
