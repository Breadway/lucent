# Lucent

Lucent is a reusable engine for coded films. Authored scenes, assets, fonts, audio and generated media live in separate film projects. The browser adapter preserves Astra DOM/SVG films and Breadway Canvas films. New films use the JavaScript/TypeScript SDK with Chromium or the optional Rust renderer.

## Get started

From ~/Projects/lucent:

    npm install
    npm run typecheck
    npm run build
    node cli.mjs inspect ../lucent-films/astra-films/astra.film.json --json
    node cli.mjs preview ../lucent-films/astra-films/astra.film.json
    node cli.mjs render ../lucent-films/astra-films/astra.film.json --size 1080p --codec av1,h265,h264 --software-fallback

The first native build needs Rust/Cargo. Rendering also needs Chromium and FFmpeg with zscale and the requested encoders. Lucent probes the requested encoder at the requested size before rendering. Software fallback must be explicitly enabled. Final exports go to ~/Videos/Breadway Films; checkpoints go to ~/.cache/lucent.

Commands: inspect, preview, stills, audio, tts, render, bench and build. Options include --backend browser|native, --size 4k|1440p|1200p|1080p|WIDTHxHEIGHT, --fps 30000/1001, --from SEC --to SEC, --workers 1|2, --keep-frames and --json. Codecs: av1, h265, h264. The play command opens an exported file with ffplay.

Rendered frame PNGs are deleted as soon as their chunk segment is encoded and verified, so long renders keep only the small segments plus manifests; a resumed render treats a verified segment with pruned frames as done. Pass --keep-frames to retain every captured PNG in the chunk cache.

See PLAN.md, docs/CONTRACTS.md, docs/CAPABILITIES.md and docs/STATUS.md for requirements, interfaces, feature support and current limits.

## Author a film

Create a separate project with a versioned *.film.json manifest, an ES module or TypeScript entry, assets and embedded fonts. The conformance example demonstrates both manifest and SDK usage. TypeScript is bundled to JavaScript with esbuild. QuickJS executes that JavaScript and provides no DOM, Canvas or Node globals. Classify every project and scene as browser-only, portable or native-only; inspect reports unavailable backends and reasons.

The @breadway/lucent SDK provides deterministic seeded randomness, groups, transforms, clipping, paths, text, images, video, cameras, timestamped scenes and versioned extensions. Declare code, media, configuration and font dependencies. Embed each font face and list ordered fallbacks. Missing font faces or glyphs produce diagnostics.

## TTS and audio

The tts command creates a script linked to stable scene/cue IDs and a Gemini configuration. Edit them and provide a key through the environment, then explicitly allow requests with --max-requests N. The default makes zero network requests. The template uses Gemini 3.8 Flash Lite TTS at 3 RPM, 10000 input TPM, 10 RPD and one concurrent request. The shared ledger accounts for project/model quotas across keys and processes.

When all cues are generated, Lucent assembles out/tts/narration.wav and timeline.json. Timestamps are scene-local. Overlay mode requires cues to fit within authored scenes and reports overlaps. Extend mode is for portable JS/TS scenes: it extends the scene, shifts following scenes and holds the final authored visual state. The audio command combines narration with declared score and audio.tracks. Tracks have source, scene/time, trim, rate, loop, gain and duration fields. Narration ducks a provided score. The result is measured and mastered during export.

Project-local plugins are declared under extensions with kind, name and file. The default export must declare apiVersion "0.1.0". TTS plugins implement generate({project, config, script, out, maxRequests, signal}); audio plugins implement render({project, timeline, out, signal}). Plugins run in the trusted authoring controller and own their credentials and accounting. The built-in Gemini provider owns its quota ledger.

## Rendering

The browser backend retains DOM, CSS, SVG, Canvas, WebGL and WebGPU. Portable JS/TS scenes use a linear-light RGBA16F browser compositor when supported, with a slower CPU fallback. Native rendering uses QuickJS, tiny-skia, Cosmic Text and wgpu; arbitrary browser globals are unavailable. Native scenes can use WGSL effects, supersampling and motion-blur sampling. Native/browser text and edge pixels may differ. Seeking is deterministic within a pinned backend and environment.

CPU transfer uses top-left, tightly packed, premultiplied linear BT.709 RGBA16F. SDR output converts matrix and range to BT.709 limited-range YUV420 while preserving the sRGB transfer values, and is tagged BT.709 so players that pass SDR through show the rendered stills without lifted shadows. H.264 uses 8-bit; AV1 and H.265 use 10-bit. Default AV1 bitrate at 30 fps: 30 Mbps at 1080p, 35 Mbps at 1200p, 60 Mbps at 1440p and 120 Mbps at 4K. Settings are configurable.

bench --json reports complete export time, steady-state FPS, render factor, stage timings, system/software, memory and observed acceleration. On the conformance film at 1080p, the native renderer completed three 60-frame H.264 exports in a median 10.43s, compared with 18.42s for Chromium on this system. The raw VideoFrame path took 40.49s. Native rendering is promising for portable scenes, but one fixture does not meet the representative-suite promotion gate. See the machine-readable reports in docs/benchmarks/ and docs/capture-evaluation.json.

## Film projects

All film projects live in `../lucent-films` (moved there from the old
top-level `../astra-films`, `../breadway-film-projects` and
`../omnia-nano-explainer` checkouts):

- `lucent-films/astra-films` contains Astra and education scenes, assets, fonts and available narration/audio.
- `lucent-films/breadway-film-projects` contains Breadway films, assets, fonts, data and player resources.
- `lucent-films/omnia-nano-explainer` contains the OmniAstra nano explainer (word-anchored scenes, TTS narration).

Original source repositories remain intact. The migrated film folders hold their own manifests and use Lucent compatibility code from outside the film projects.
