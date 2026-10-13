# Capability inventory

The engine preserves the originals through browser compatibility adapters. Film collections are stored in `../lucent-films/astra-films` and `../lucent-films/breadway-film-projects`; they do not contain a copy of the reusable engine.

| Capability                                                                 | Source         | Engine interface                                    |
| -------------------------------------------------------------------------- | -------------- | --------------------------------------------------- |
| HTML/CSS/SVG scenes and educational diagram kit                            | Astra          | `compat/astra`, browser adapter                     |
| Same Astra scenes, natively (SVG tree built in QuickJS, rendered by resvg) | Astra          | `compat/astra/native`, `svg` node, docs/svg-node.md |
| Canvas scenes and all component libraries                                  | Breadway Films | `compat/breadway`, browser adapter                  |
| Timeline overlaps, chapters, captions, narrated and original pacing        | Astra          | original Stage and common inspection/viewer         |
| Layers, fade/glitch/zoom/whip, bloom, grain, drift                         | Breadway Films | original compositor                                 |
| Supersampling, motion-blur samples, portrait formats                       | Breadway Films | `--ss`, `--mb`, `--shutter`, design dimensions      |
| Photos and image sequences                                                 | Breadway Films | async frame preparation                             |
| Voice-led score and BOS score                                              | Breadway Films | `audio` with bounded score windows                  |
| Streaming procedural score                                                 | Astra          | `audio`, disk-backed streaming                      |
| Mastering and AV1/H.264 delivery                                           | Both           | verified common encode/mux path                     |
| H.265, 4K/1440p/1200p/custom dimensions                                    | New            | common export settings                              |
| Portable typed scenes and dependencies                                     | New            | JS/TS SDK and versioned manifest                    |
| Colour-managed multi-deliverable export                                    | New            | Rust frame boundary and FFmpeg conversion           |
| Quotas, key pools and durable TTS caching                                  | New            | film-linked scripts, SQLite ledger                  |

No existing film is classified as portable automatically. Native support is negotiated per operation, not inferred from authoring language. API and cache versions are explicit. Hardware acceleration must be observed; presence in encoder help is insufficient evidence.
