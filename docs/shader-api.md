# Native shader API 0.1.0

A native-only scene may return `{type: 'shader', wgsl: source}` after other drawing nodes. Declare `requires: ['shader-wgsl']`. The node transforms the current full frame in linear premultiplied RGBA16F. It does not accept DOM/Canvas code, GLSL, clipping or arbitrary browser uniforms.

WGSL must provide `vs` and `fs` entry points. Binding 0 in group 0 is an unfiltered `texture_2d<f32>` containing the frame before the effect. Vertex input is `vertex_index`; render a fullscreen triangle. Fragment coordinates index the texture with `textureLoad`. Return premultiplied RGBA. Shader validation errors fail the export; unsupported browser execution is reported by capability negotiation.

Time-dependent parameters can be encoded in generated WGSL from deterministic film timestamps. This is an initial interface; future uniform bindings require an API version change. Shader support remains native-specific rather than being labelled portable.
