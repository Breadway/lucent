# Reusable Lucent with browser compatibility and native rendering

## Summary and delivery order

Create `~/Projects/lucent` with a Rust runtime, JS/TS SDK, browser rendering and an optional native GPU backend. Film scenes, narration, assets and generated media live in separate projects. Migrate both existing collections while preserving originals. Launch on Linux, keeping interfaces portable.

1. Inventory capabilities and establish reference frames, audio/playback checks, conformance fixtures and demanding export benchmarks.
2. Extract shared functionality, implement compatibility adapters and migrate both collections.
3. Deliver unified exports, media clips, TTS scheduling, capability negotiation and recovery.
4. Add native graphics/playback and evaluate optimized capture paths.

Native development is gated on working extraction, adapters, both migrations and passing reference/conformance fixtures. Frame capture/transport is the primary optimization target; eliminating 1 ms of drawing cannot materially improve a cycle dominated by 93 ms screenshot capture.

## Authoring, compatibility and versioned interfaces

- Publish `preview`, `render`, `stills`, `audio`, `tts`, `inspect`, `bench` and build commands.
- Transpile/bundle JS/TS with esbuild into JavaScript before native execution. Type-check TS separately. QuickJS executes JavaScript and provides explicit engine host APIs, not Node or browser globals.
- Use manifest schema 1 and SDK/extension API 0.1.0 with explicit compatibility requirements. Reject incompatible versions before execution. Explicit migrations create backups; rendering never silently rewrites manifests.
- Projects and scenes declare `browser-only`, `portable` or `native-only`, plus required capabilities. `inspect --json` reports executable backends and reasons for missing support.
- Preserve Astra DOM/SVG `build/update` and Breadway Films Canvas APIs through browser adapters. Do not infer native portability from JS/TS authoring.
- Preserve educational diagrams, typography, charts, portraits, image sequences, vertical formats, transitions, camera motion, bloom/grain, supersampling, motion blur, both procedural score engines, mastering, chapters, captions and narrated/original pacing.
- Make code, assets, configuration, fonts, audio and generated-media dependencies explicit, including producer versions. Invalidation includes transition neighbours and audio/effect preroll; whole-film invalidation is a legacy fallback.
- Central cache schema includes engine/build/SDK/extension versions, backend/environment, dependency fingerprints, timestamps, seed, render/effect settings, design/output dimensions and colour profile. Encoding adds codec/encoder versions and settings.
- Embed project fonts with family, weight, style, variable axes and content hashes. Missing fonts/glyph coverage fail unless an ordered fallback is explicitly declared. Pin native Cosmic Text shaping; define direction, language, wrapping, alignment, kerning, ligatures and line height.
- Use one timestamp-based timeline for animation, video, captions and audio. Export uses rational frame rates and audio sample timestamps. Playback uses the audio device position when available, otherwise a monotonic clock. Frame arrival never advances time.
- Repeatability is guaranteed within a pinned backend/version/environment/fonts/assets/seed. Cross-backend floating-point, shaping and rasterization differences are measured and documented, not described as bit-identical.

## Rendering, colour and exports

- Keep Chromium for full HTML/CSS/SVG/Canvas, custom WebGL/WebGPU and lossless reference capture.
- Benchmark Canvas `VideoFrame` transport/WebCodecs and experimental CEF raw/GPU callbacks. Neither substitutes for arbitrary DOM composition or proves zero-copy interoperability.
- After the native gate, execute bundled JavaScript through QuickJS and use Rust `wgpu` for the retained scene graph: groups, transforms, clipping, paths, shaped text, images, video textures, cameras, transitions, shader materials and effects.
- Renderers/encoders expose versioned capabilities for graphics APIs, formats, dimensions, bit depths, codecs/profiles, effects, hardware and surface interoperability. Probe requested real encode/decode combinations before export. Require explicit fallback; never silently remove effects or lower quality.
- Canonical frame descriptor 1 carries dimensions, rational timestamp/duration, colour metadata, alpha, strides/offsets, ownership and synchronization. CPU working pixels are interleaved little-endian RGBA16F, linear-light BT.709/sRGB primaries, full range and premultiplied alpha, top-left origin, tightly packed `width * 8` rows.
- GPU-native surfaces can bypass CPU conversion only through negotiated, tested equivalent colour/alpha/precision/synchronization. Strip padded rows on readback. Import browser and media formats explicitly; 8-bit sources remain 8-bit in effective precision.
- Preserve legacy browser composition. New portable composition and alpha flattening use linear light. Flatten against configured background, default black.
- Encode SDR BT.709 primaries, transfer and matrix, limited range, with explicit dithering. H.264 uses 8-bit YUV420/NV12; AV1/H.265 use 10-bit YUV420/P010. Verify tags and decoded pixels. HDR/wide-gamut delivery is outside the first release.
- Presets are 3840x2160, 2560x1440, 1920x1200 and 1920x1080, plus custom dimensions. Separate design/output resolution; default fit, explicit fill/stretch.
- AV1 bitrate defaults at 30 fps: 120/60/35/30 Mbps for 4K/1440p/1200p/1080p, scaled with frame rate. Expose bitrate/quality modes and real hardware/software fallback.
- Generate deliverables from common rendered frames or a lossless intermediate rather than transcoding a compressed master.
- Provide browser and native playback, chapters/captions/seeking/frame stepping/volume/fullscreen, exported-video viewing and embedded clips with trim/loop/rate/transforms/source audio. Export decodes clips by presentation timestamp.
- Keep caches/output separate; final media defaults to `~/Videos/Breadway Films`.

## Audio, TTS and recovery

- Preserve procedural scores, retiming, ducking, bounded generation, reverb continuity, correlation-aware seams and mastering after assembly.
- Link narration to stable scene/cue IDs; separate text, pronunciation, style and voice. Provide versioned Gemini/local/existing-audio APIs with generation, accounting, caching and alignment.
- Default Gemini 3.8 Flash Lite TTS quotas: 3 RPM, 10000 input TPM, 10 RPD, one concurrent request. Verify endpoint/model identifiers. Keys remain in environment/OS credentials.
- Pool keys by project/model quota groups; rotate to another eligible group when exhausted. Same-project keys share accounting; daily reset follows Pacific time.
- Persist cross-process reservations, budgets and cooldowns. Honour retry delays and checkpoint when exhausted. Unknown quota errors must not rapidly cycle keys.
- Cache speech by script/model/voice/style/pronunciation and preserve original recordings/provenance. Prefer real timing or forced alignment; label estimated alignment and expose diagnostics.
- Bound queues, memory and disk, share CPU/GPU leases across processes, start with two browser workers.
- Crashes fail active chunks and cancel dependent work. Disk exhaustion stops writes. Cancellation terminates owned children and preserves verified checkpoints.
- Temporary files never qualify as outputs. Verify checksums, decodeability, counts, timestamps, dimensions and settings before atomic promotion. Restart verifies chunks; quarantine corrupt entries and rebuild. Existing deliverables survive failure.

## Conformance, performance and acceptance

- Shared portable tests cover transforms, clipping, paths, typography, images, cameras, transitions, supported shaders/effects, seeking and deterministic generation. Report backend-specific features explicitly.
- Pinned comparisons are exact where stable; cross-backend comparisons report pixel error, structural similarity, geometry and text bounds with reviewed per-fixture limits. Never widen limits automatically to pass.
- Colour tests cover primaries/greys/black-white levels/dark ramps/saturated patches/alpha edges/8-10-bit conversions, checking decoded values and tags for range/transfer/colour errors.
- Exercise every migrated scene and all size/codec combinations. Test audio seams/loudness/peaks/sync, fonts, capability errors, quotas/rotation/reset/concurrency, dependency invalidation, corruption, crashes/cancellation and disk exhaustion.
- Benchmark DOM-heavy, SVG, Canvas, large-image, dense-text, bloom, sequence, overlap, motion-blur and 4K fixtures.
- Report whole-pipeline steady-state FPS, total wall time and render factor `wall time / media duration`, e.g. `0.42x realtime`. Report drawing/capture/transport/conversion/encoding/startup/flush separately; overlapping timings are not additive.
- Versioned `bench --json` includes hardware/software versions, backend, scene, dimensions, frames/rate, timings, FPS, wall time, render factor, memory and observed acceleration (unknown if unobservable).
- Promote optimizations only with at least 20% improvement across repeated representative end-to-end exports at identical scenes/settings/quality/deliverables, preserving features and passing correctness. Capture microbenchmarks alone do not qualify.
- Validate GPU performance on actual Linux hardware; unvalidated paths remain experimental.
