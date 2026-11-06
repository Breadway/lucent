# Native frame hand-off

LUCENT-2 measured the path from a finished native frame to ffmpeg. The short
version: the per-frame transfer table rebuild and the slow PNG compression are
already gone from the trunk. The remaining PNG encode/decode is real work, but
a raw frame packet is slower once the frame cache is involved, so this change
records the measurement and locks the existing fast paths down with tests.

## Path

1. `Renderer::sampled` (`src/native.rs`) encodes the frame as a 16-bit RGBA
   PNG. Single-sample frames (`ss == 1` and `mb == 1`) go through
   `encode_frame_f16`, a 65,536 entry sRGB table built once in
   `Renderer::new`. Accumulated frames go through `encode_frame`, which
   converts each f32 sample. Both call `png16`, which uses
   `CompressionType::Fast` and `FilterType::Sub`.
2. `src/render.mjs` writes that PNG to the chunk frame cache and records its
   hash for reuse.
3. `encodeImages` (`src/media.mjs`) reads each cached PNG, prefixes its length,
   and pipes it into `lucent frame-stream`.
4. `frame-stream` (`src/main.rs`) decodes the PNG, verifies the frame is
   flattened, maps RGB through the process-constant transfer table, and writes a
   big-endian 16-bit PPM for ffmpeg.

## Already fixed before this measurement

- The transfer table was rebuilt inside the per-frame loop. Commit `b832fc6`
  moved it out and switched from a `write_all` per channel to one write per
  row. This repository now builds it once in `frame_stream_lut`.
- The internal PNG already uses Fast compression. Stills use the same encoder,
  so any change there would have changed still output; none was made.
- Single-sample frames already skip f32 accumulation and use the half-float
  table path.

## Measurement method

- Machine: AMD Ryzen AI 7 350 with Radeon 860M, btrfs on NVMe, FFmpeg 9.0.2,
  Node 22.23.4. Release binary built with `cargo build --release --locked`.
  Other agents were active on the machine, so full-pipeline figures are ranges
  and the isolated stage profiles are medians.
- Fixture: `examples/conformance/conformance.film.json`, native backend,
  1920x1080, frame at t=1.0. The 16-bit RGBA PNG is 484,094 bytes, a
  representative low-entropy typographic frame.
- Worst case: a 1920x1080 random-noise 16-bit RGBA PNG, 14,640,344 bytes. This
  bounds decode cost for a frame whose PNG does not compress.
- Hand-off: `node tools/bench-frame-handoff.mjs --frame FRAME --frames 24
--repeat 5`. The tool feeds length-prefixed PNGs to `frame-stream` with
  stdout discarded, after one warm-up, and reports the median wall time. It
  includes one process start and the one-time table build, amortized over 24
  frames. `--ffmpeg` additionally pipes the PPM into
  `ffmpeg -f image2pipe -c:v ppm -i - -f null -` to measure ffmpeg parsing.
- Renderer stages: `LUCENT_PROFILE=1` against `native-server` for 24 frames,
  reading the `render_linear+readback` and `png-encode` profile lines.
- Full export: two `node cli.mjs render ... --from 1 --to 1.4 --fps 30
--workers 1 --chunk 12 --codec h264 --encoder vaapi --json` runs. The report
  splits per-frame drawing, transport, and `conversionEncodeMs` (frame-stream
  plus ffmpeg zscale and VAAPI).

## Results

Per 1920x1080 frame, typical 484 KB PNG:

| Stage                                                   | Time                   |
| ------------------------------------------------------- | ---------------------- |
| Native render and readback (`render_linear+readback`)   | 7.8 ms                 |
| PNG encode, Fast + Sub (`png-encode`)                   | 10.5 ms                |
| Write PNG to the chunk cache (`transportMs`)            | 0.26 ms                |
| `frame-stream`: PNG decode + transfer table + PPM write | 6.0 ms                 |
| Same, before the table hoist                            | 7.9 ms                 |
| FFmpeg PPM parse to a null output                       | about 4 to 7 ms, noisy |
| Full H.264 VAAPI export per frame                       | 55 to 64 ms            |

The hoist saves 1.9 ms per frame on this fixture (7.91 to 6.01 ms, medians of
five 24-frame runs). That matches the original commit's 64.7 to 56.9 ms for
five frames.

PNG encode plus decode is 16.5 ms, roughly 26 to 30 percent of a 55 to 64 ms
VAAPI frame. The rest of `conversionEncodeMs` is FFmpeg's zscale/dither and
the hardware encoder. This is the reason the remaining options were measured
instead of assumed.

Worst-case noise frame:

| Stage                                      | Time                                                    |
| ------------------------------------------ | ------------------------------------------------------- |
| `frame-stream`: decode + table + PPM write | 50 ms at the low end, up to 75 ms under concurrent load |
| Plus FFmpeg PPM parse                      | about 59 ms at the low end                              |

## Why no raw frame packet

- A 1920x1080 RGBA16F frame is 16.6 MB, versus 0.48 MB for the Fast PNG. The
  cache stores every captured frame for chunk resume and hashes it. A
  1,800-frame chunk would grow from under 1 GB to about 30 GB, and the prune
  and resume paths would change.
- Writing and reading a 16.6 MB random buffer on this btrfs NVMe measured
  13.4 ms write and 10.3 ms read, or 23.7 ms per frame with the page cache
  warm. The PNG encode and decode it would replace costs 16.5 ms. Raw is
  slower before counting the extra pipe copies and the larger working set.
- A memory-only raw path would have to stream capture directly into the
  encoder, losing the chunk cache, resume and verified-segment design. That is
  not a small, stable change.
- Replacing the PPM with an ffmpeg `rawvideo` stream would save about 1.6 ms
  per frame of parsing (4.98 to 3.33 ms measured with a null output), but it
  removes the self-describing frame headers and the width/height check.
  Losing detection of a desynchronized stream is not worth 1.6 ms.
- Passing sRGB samples straight through for half-float-origin frames saved
  0.73 ms per frame (6.17 to 5.44 ms) and produced a byte-identical PPM, but
  it needs a per-frame marker and a second decode path. It is not worth the
  protocol change.

## Pixel equivalence

- `native::tests::fast_f16_encode_is_byte_identical_to_reference` builds a
  256x256 image that covers all 65,536 f16 bit patterns, encodes it through
  `encode_frame` and `encode_frame_f16`, and asserts the PNG bytes and the
  decoded RGBA16 pixels are identical.
- `tests::frame_stream_lut_is_identity_for_half_origin_samples` checks that
  every sample the fast encoder can produce maps back to itself through the
  hand-off table. The table is process-constant, so hoisting it cannot change
  pixels; the test makes that invariant explicit.
- `b832fc6` also reported byte-identical 1080p output for the hoist and row
  write change. Stills use the same `sampled` encoder, so their PNGs are
  unchanged.

## Reproduce

```sh
cargo build --release --locked
node tools/bench-frame-handoff.mjs \
  --frame /path/to/frame.png --frames 24 --repeat 5
node tools/bench-frame-handoff.mjs \
  --frame /path/to/frame.png --frames 24 --repeat 5 --ffmpeg
node cli.mjs stills examples/conformance/conformance.film.json \
  --backend native --size 1080p --times 1 --out /tmp/lucent-handoff
node cli.mjs render examples/conformance/conformance.film.json \
  --backend native --size 1080p --from 1 --to 1.4 --fps 30 --workers 1 \
  --chunk 12 --codec h264 --encoder vaapi --json
```

## Residual risks

- Figures come from one machine and one low-entropy fixture. A grain or
  photographic film can make PNG decode the dominant stage, as the noise bound
  shows.
- Full-pipeline timings move with concurrent load. The isolated profiles were
  stable across runs; the full export is reported as a range.
- Supersampled and motion-blurred frames still use `encode_frame`, which
  converts each f32 sample rather than reading the half-float table. That is
  existing behavior and is outside this measurement.
