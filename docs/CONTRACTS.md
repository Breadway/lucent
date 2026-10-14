# Engine contracts, version 0.1.0

## Authoring and compatibility

Manifest `schemaVersion` is 1; SDK and provider APIs are 0.1.0. Unsupported versions fail before execution. TypeScript is transpiled and bundled by esbuild; QuickJS receives JavaScript. Native host APIs do not provide DOM, Canvas, or Node globals. Projects and scenes declare `browser-only`, `portable`, or `native-only`, with required capabilities. Inspection reports backend-specific reasons.

New scenes declare imported code, assets, configuration, audio, fonts, generated media and producer versions in `dependencies`. Unknown legacy dependencies invalidate the whole film. Cache schema 1 includes engine, backend and runtime versions, source/dependency hashes, seed, timeline range, design/output sizes, effects, colour conversion and encoder settings. Temporary files are never cache hits.

## Media clock

Presentation timestamps are authoritative. Export derives timestamps from frame index and a rational rate; audio is sample-based. Narration, captions and embedded media consume timeline timestamps. Playback reads the audio clock when available and a monotonic clock otherwise. Arrival of a frame never changes the timeline.

## Frame descriptor 1

Canonical CPU data is top-left, row-major, interleaved little-endian RGBA16F. Stride is `width * 8`. RGB uses linear light, BT.709/sRGB primaries, full range and premultiplied alpha. Source 8-bit precision is recorded and never described as restored by up-conversion. Frame storage must carry timestamps, dimensions, colour, alpha, strides, ownership and synchronization. GPU padding must be removed at readback.

The browser adapter preserves legacy browser composition and normalizes captured output at the Rust boundary. Encoding accepts already-flattened frames. Working RGB is converted from linear light to SDR BT.709 transfer/matrix and limited-range YUV. H.264 is 8-bit 4:2:0; AV1/H.265 are 10-bit 4:2:0. Integer conversion uses error-diffusion dither. Primaries, transfer, matrix and range tags are verified after decoding.

GPU bypasses require demonstrated equivalent colour and precision, explicit resource ownership and completion synchronization. Untested surface interop is unavailable. HDR/wide-gamut export is outside version 0.1.0; do not silently interpret such material as SDR.

## Typography and determinism

Portable projects embed font files with family, weight and style. Missing files or undeclared font families fail. System fallback is not a deterministic export contract. Line wrapping, direction, size, line height, alignment, kerning and letter spacing are explicit scene properties. Direct text leaves take `letterSpacing` (design px after every character, default 0) and need the `text-letter-spacing` native capability when it is non-zero. Legacy browser adapters retain their original typography. Native shaping uses pinned Cosmic Text.

Within pinned software, assets, fonts, seeds and environment, arbitrary seeking must reproduce scene state. Backend rasterization differences are measured; cross-backend bit identity is not promised. Software Chromium can change a few text-edge samples during glyph-cache warmup; verification records both exact equality and maximum per-channel error, and this must be resolved or explicitly reported rather than hidden.

## Recovery and resources

Chunks are checksum-validated and decoded before reuse. Interrupted chunks remain temporary. A final file is atomically promoted only after verification, so failures do not replace existing deliverables. Renderer/encoder failure cancels dependent work; cancellation terminates owned children. Disk space is checked before frame capture. Job and CPU/GPU leases account across processes.

TTS uses SQLite transactions, project/model quota scopes, rolling minute limits and Pacific daily resets. Requests are reserved before sending; uncertain or failed requests conservatively consume budget. Key rotation uses eligible quota groups and does not reset a shared-project quota. Keys are never written to scripts, logs, cache or the ledger. Generation requires an explicit request budget; the default performs no network requests.

## Performance

Render factor is export wall seconds divided by media seconds, labelled `Nx realtime` (smaller is faster). Report total export FPS and steady-state throughput alongside overlapping stage timings. `bench --json` uses schema 1 and includes runtime/hardware, scene IDs, resolution, frame count/rate, memory and observed acceleration. Unknown acceleration remains unknown.

The 20% promotion threshold applies to repeated, equivalent end-to-end exports including required deliverables and correctness checks. A faster isolated screenshot operation is insufficient. CEF and WebCodecs paths remain experimental until that gate passes.

### Reviewed legacy reference difference

At 640x360, the educational film's `c9_smooth` and `c12_nan` samples each differ from the original HUD in 46 pixels bounded by x436..621, y15..38. Maximum channel error is 5/255, frame RMSE is about 0.012. The differences are confined to HUD compositing/text edges and were visually inspected. The generic reference tolerance remains RMSE 0.2 and maximum channel error 4; this narrowly recorded exception does not widen other fixture limits. All other tested scene midpoints match the reference exactly.
