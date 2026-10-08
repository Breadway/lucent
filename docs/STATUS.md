# Lucent implementation status

Lucent keeps film code and media in ../astra-films and ../breadway-film-projects. Original sources were preserved. The migration report covers all 13 manifests and every scene's start, middle and end samples. Two educational HUD samples differ in text-edge compositing; the bounded differences are documented in CONTRACTS.md and do not widen generic tolerances.

The JS/TS SDK, Chromium adapters, QuickJS/wgpu renderer, native coded-film viewer, ffplay export playback, versioned manifests, project-local extension contract, dependency-based cache, Gemini quota ledger, timestamped narration assembler, procedural audio providers, BT.709 encoder and checkpoint recovery are implemented. TypeScript is bundled to JavaScript before QuickJS runs. Arbitrary DOM and Canvas scenes remain browser-only, except Astra-style DOM/SVG films, which can run natively through the `svg` leaf and the DOM shim in `compat/astra/native` (see docs/svg-node.md).

Native implementation began after migration, references and portable fixtures passed. Headless native rendering ran on local GPU hardware. The windowed native viewer has compiled but has not been opened on the user's desktop. Requested encoders are probed; unavailable hardware paths fail unless software fallback is allowed.

Experimental raw VideoFrame capture and native frame capture have correctness checks, but neither meets the 20% repeated end-to-end promotion requirement. CEF surface integration is unavailable. WebCodecs is probed per browser and codec, but is not the default export path. inspect reports missing backend features and native export refuses browser-only scenes.

TTS defaults to zero network requests. It needs an explicit request budget and an environment key. Default quotas are 3 RPM, 10000 input TPM, 10 RPD and concurrency one. Multiple keys in one project share the same accounted quota.

Native advertises its retained scene graph, WGSL shaders, embedded text, image/video frames, supersampling and motion blur. It does not claim DOM/CSS or arbitrary Canvas compatibility. Native/browser rasterization can differ at text edges and filtered layers. Cache keys include code, declared dependencies, fonts, timestamps, settings and renderer versions.

Corrupt frames, encoded chunks and cache records are quarantined and rebuilt. Temporary chunks are never final outputs. Outputs are atomically replaced only after decode and colour-tag checks. Failures and cancellation retain verified checkpoints.

On the portable conformance fixture at 1080p, three native H.264 exports took a median 10.43s for 60 frames, compared with 18.42s through Chromium. Native rendering used the AMD Radeon 860M; headless Chromium reported SwiftShader. The raw VideoFrame transport took 40.49s and was 54.5% slower end to end than Chromium PNG. These runs show the native backend's promise on a portable scene and the cost of raw capture. Native remains experimental because this fixture does not cover the full nasty-scene set. Machine-readable reports are in docs/benchmarks/ and docs/capture-evaluation.json. tools/bench-suite.mjs runs repeated exports at 1080p and 4K with machine-readable full-pipeline results. The native windowed viewer and external CEF integration still need platform-specific manual work.

## Native renderer performance (2026-10)

Per-leaf work in the native renderer is bounded to each primitive's region: one reused scratch
surface and GPU texture, no full-frame scan or per-leaf stall, exact lookup tables for the
colour conversions. On a 187-primitive 1080p scene a frame fell from about 1000 ms to 136 ms
with decoded pixels unchanged (`LUCENT_VERIFY_BBOX=1` checks the regions). `render` validates
cached frames from the PNG header instead of decoding them, which made a fully cached re-run of
48 frames 11x faster.
