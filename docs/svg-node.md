# SVG scene leaf and the native Astra path

A scene may return `{type: "svg", markup, grain?}` (`svg(markup, props)` in the SDK). The native
renderer parses `markup` with usvg, rasterises it with resvg at the frame's design-to-pixel
transform, and blends the result like any other leaf. Declare `requires: ["svg"]`.

- The document is in design-space units; its own `width`/`height`/`viewBox` should match the
  design size. Text uses only the fonts declared in the manifest. resvg applies a font's
  variable `wght` axis from `font-weight`, but only for weights that are multiples of 100.
- A run of text is reshaped **entirely** in a fallback font as soon as one glyph is missing from
  the primary font. Scripts that can hit this should split runs themselves (the Astra shim does).
- `grain: {seed, opacity = 0.055, width = 320, height = 180}` overlays deterministic noise,
  scaled up without smoothing, with the `overlay` blend (the Astra page's film grain).
  The leaf routine shares the frame-level seed rule: an optional `frame` index is added
  to `seed` with 32-bit wrapping, so per-frame leaf grain stays reproducible across
  reruns and out-of-order seeks.
- Clip masks from enclosing groups are not applied to the document. Group opacity is.
- A filter's default region is the content bounding box +10%, which resvg clamps to five frames.
  Give large blurs `filterUnits="userSpaceOnUse"` and a frame-sized region.
- Scripts running in QuickJS get two host functions: `__measure_text(text, family, weight,
size, letterSpacing)` (shaped advance, same shaper and faces as drawing) and
  `__has_glyph(family, codePoint)`.

## Running an Astra (DOM/SVG) film natively

`compat/astra/native/` runs an Astra film's own scene code unchanged:

- `dom.js` is a minimal DOM (elements, attributes, a `style` bag, text, path geometry for
  `getTotalLength`/`getPointAtLength`, `getComputedTextLength`) that serialises to SVG. It also
  supplies en-US `toLocaleString`, CSS weight matching onto the declared faces, and the fallback
  run splitting described above.
- `stage.js` ports the browser Stage. Timeline, narration retiming and transitions are the same
  code; the canvas background, CSS HUD, captions, vignette and progress bar are rebuilt as SVG.
- `film.js` (`createAstraFilm`) maps a film to scenes: one entry per authored scene (so the
  timeline matches the browser's) plus one `astra-stage` scene that draws the frame.

A project supplies `film.js`:

```js
import { createAstraFilm } from "/engine/compat/astra/native/film.js";
import scenes, { OPTS } from "../scenes_edu/index.js";
import narration from "../out/edu/narration.json";
export default createAstraFilm({
  scenes,
  narration,
  opts: { film: "edu", ...OPTS },
});
```

`/engine/...` imports resolve to this repository, as they do for the browser adapter. See
`lucent-films/astra-films/edu-native/` (Astra Film 2) for a complete project, including how its fonts are
prepared. `inspect` always opens a browser, so use `build --backend native` and `render --backend
native` for these films.

Measured on Astra Film 2 (83 scenes, 2958 s): every scene renders; across 249 sample frames the
native result differs from the browser's by a median 2.6/255 mean absolute error (25.7 dB PSNR),
worst 4.2, mostly text-edge antialiasing. Frames take ~210 ms on average; a scene-wide blur
(transitions, chapter cards) costs up to ~0.8 s.

## Debugging aids

|                                                    |                                                              |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `LUCENT_PROFILE=1`                                 | per-stage timings for every frame on stderr                  |
| `LUCENT_VERIFY_BBOX=1`                             | assert no primitive draws outside its computed region (slow) |
| `LUCENT_DUMP_SVG=dir`                              | write the last SVG document to `dir/last.svg`                |
| `lucent svg-render file.svg manifest.json out.png` | rasterise one SVG with a project's fonts and time it         |
| `LUCENT_FONT_LIST=1`                               | with `svg-render`, list the faces loaded from the manifest   |
