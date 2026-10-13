use crate::svg::{self, FontDb, Svg};
use anyhow::{bail, Context as _, Result};
use cosmic_text::{Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache};
use futures_lite::future::block_on;
use half::f16;
use resvg::tiny_skia as sk;
use rquickjs::{Context, Runtime};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    rc::Rc,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tiny_skia::{FillRule, Mask, Paint, PathBuilder, Pixmap, Rect, Stroke, Transform};

const SHADER: &str = r#"
@group(0) @binding(0) var picture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;
struct Params { opacity: f32, _pad0: f32, _pad1: f32, _pad2: f32 };
struct Output { @builtin(position) position: vec4<f32> };
@vertex fn vs(@builtin(vertex_index) id: u32) -> Output {
 var p=array<vec2<f32>,3>(vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));
 var o: Output; o.position=vec4(p[id],0.,1.); return o;
}
fn to_linear(c: f32) -> f32 {
 return select(pow((c + 0.055) / 1.055, 2.4), c / 12.92, c <= 0.04045);
}
@fragment fn fs(in: Output)->@location(0) vec4<f32> {
 let texel=textureLoad(picture,vec2<i32>(in.position.xy),0);
 let a=texel.a;
 if (a <= 0.0) { return vec4<f32>(0.0); }
 // Unpremultiply in sRGB (as the old CPU table did), linearise, re-premultiply.
 let srgb=min(texel.rgb / a, vec3<f32>(1.0));
 let lin=vec3<f32>(to_linear(srgb.r), to_linear(srgb.g), to_linear(srgb.b));
 let ao=a * params.opacity;
 return vec4<f32>(lin * ao, ao);
}
"#;
fn v(n: &Value, key: &str, default: f32) -> f32 {
    n[key].as_f64().map(|x| x as f32).unwrap_or(default)
}
fn color(s: &str) -> Result<[u8; 4]> {
    let s = s
        .strip_prefix('#')
        .context("Use #RRGGBB or #RRGGBBAA colours")?;
    if s.len() != 6 && s.len() != 8 {
        bail!("Invalid colour {s}");
    }
    let mut a = [0, 0, 0, 255];
    for i in 0..s.len() / 2 {
        a[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)?;
    }
    Ok(a)
}
fn linear(s: f32) -> f32 {
    if s <= 0.04045 {
        s / 12.92
    } else {
        ((s + 0.055) / 1.055).powf(2.4)
    }
}
fn encoded(l: f32) -> f32 {
    let l = l.clamp(0., 1.);
    if l <= 0.0031308 {
        12.92 * l
    } else {
        1.055 * l.powf(1. / 2.4) - 0.055
    }
}
fn safe_asset(root: &Path, file: &str) -> Result<PathBuf> {
    let p = root.join(file).canonicalize()?;
    if !p.starts_with(root) {
        bail!("Asset escapes project: {file}");
    }
    Ok(p)
}
/// Decode-once helper: premultiplied tiny-skia surface from an sRGB RGBA8 image.
/// The source surface never depends on per-frame transforms, so still images
/// are decoded and premultiplied once and reused for every frame.
fn rgba_to_pixmap(image: image::RgbaImage) -> Result<Pixmap> {
    let (w, h) = image.dimensions();
    let mut src = Pixmap::new(w, h).context("image allocation")?;
    for (dst, p) in src.pixels_mut().iter_mut().zip(image.pixels()) {
        *dst = tiny_skia::Color::from_rgba8(p[0], p[1], p[2], p[3])
            .premultiply()
            .to_color_u8();
    }
    Ok(src)
}
/// A short constant-frame-rate clip, fully decoded at first use so every
/// presentation timestamp is an index lookup instead of an ffmpeg spawn.
/// Selection matches `-ss` accurate-seek semantics: the first frame covering
/// the timestamp, verified pixel-identical on the conformance clip.
struct Clip {
    fps: f64,
    frames: Vec<Arc<Pixmap>>,
}
/// (width, height, fps, frame count) for clips worth pre-decoding: short,
/// constant-frame-rate and small enough to hold in RAM. Anything else bails
/// and the caller keeps per-timestamp seeks.
fn ffprobe_clip(source: &Path) -> Result<(u32, u32, f64, usize)> {
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,avg_frame_rate,r_frame_rate,duration,nb_frames",
            "-of",
            "default=noprint_wrappers=1",
        ])
        .arg(source)
        .output()?;
    if !out.status.success() {
        bail!("ffprobe failed for {}", source.display());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let get = |key: &str| -> Result<&str> {
        text.lines()
            .find_map(|l| l.strip_prefix(&format!("{key}=")))
            .context(format!("ffprobe has no {key}"))
    };
    let frac = |s: &str| -> Result<f64> {
        if let Some((a, b)) = s.split_once('/') {
            let (a, b): (f64, f64) = (a.parse()?, b.parse()?);
            if b == 0. {
                bail!("Bad frame rate {s}");
            }
            Ok(a / b)
        } else {
            Ok(s.parse()?)
        }
    };
    let (w, h): (u32, u32) = (get("width")?.parse()?, get("height")?.parse()?);
    let (avg, r) = (frac(get("avg_frame_rate")?)?, frac(get("r_frame_rate")?)?);
    let (dur, n): (f64, usize) = (get("duration")?.parse()?, get("nb_frames")?.parse()?);
    if !(w > 0 && h > 0) || !avg.is_finite() || avg <= 0. || !dur.is_finite() || dur <= 0. {
        bail!("Unusable clip metadata");
    }
    if (r - avg).abs() > 1e-6
        || dur > 10.
        || (n as f64 - dur * avg).abs() > 2f64.max(0.02 * dur * avg)
    {
        bail!("Clip is long or variable-frame-rate; seeking per timestamp");
    }
    if (w as u64) * (h as u64) * (n as u64) > 32_000_000 {
        bail!("Clip too large to pre-decode");
    }
    Ok((w, h, avg, n))
}
fn load_clip(source: &Path) -> Result<Clip> {
    let (w, h, fps, n) = ffprobe_clip(source)?;
    let out = std::process::Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(source)
        .args(["-f", "rawvideo", "-pix_fmt", "rgba", "-"])
        .output()?;
    if !out.status.success() {
        bail!("Clip decode failed for {}", source.display());
    }
    let frame = (w as usize) * (h as usize) * 4;
    if out.stdout.len() != frame * n {
        bail!("Clip decode produced an unexpected frame count");
    }
    let mut frames = Vec::with_capacity(n);
    for bytes in out.stdout.chunks_exact(frame) {
        let image =
            image::RgbaImage::from_raw(w, h, bytes.to_vec()).context("clip frame")?;
        frames.push(Arc::new(rgba_to_pixmap(image)?));
    }
    if frames.is_empty() {
        bail!("Clip has no frames");
    }
    Ok(Clip { fps, frames })
}
/// Opt-in per-stage timing (set LUCENT_PROFILE=1); totals print to stderr after every frame.
#[derive(Default)]
struct Profile {
    enabled: bool,
    stages: Vec<(&'static str, Duration, u32)>,
}
impl Profile {
    fn add(&mut self, stage: &'static str, since: Instant) {
        if !self.enabled {
            return;
        }
        let elapsed = since.elapsed();
        match self.stages.iter_mut().find(|s| s.0 == stage) {
            Some(s) => {
                s.1 += elapsed;
                s.2 += 1;
            }
            None => self.stages.push((stage, elapsed, 1)),
        }
    }
    fn flush(&mut self) {
        if self.enabled {
            let line: Vec<String> = self
                .stages
                .drain(..)
                .map(|(n, d, c)| format!("{n}={:.1}ms/{c}", d.as_secs_f64() * 1e3))
                .collect();
            eprintln!("profile {}", line.join(" "));
        }
    }
}
const SYNC_EVERY: u32 = 32;
/// Pixel region (left, top, right, bottom), right/bottom exclusive.
type Region = (u32, u32, u32, u32);
/// Conservative pixel region covering `bounds` (already in target space), padded for
/// anti-aliasing, clamped to the frame. None when it lies entirely outside.
fn region_of(bounds: Rect, pad: f32, width: u32, height: u32) -> Option<Region> {
    let clamp = |v: f32, max: u32| v.clamp(0., max as f32) as u32;
    let left = clamp((bounds.left() - pad).floor(), width);
    let top = clamp((bounds.top() - pad).floor(), height);
    let right = clamp((bounds.right() + pad).ceil(), width);
    let bottom = clamp((bounds.bottom() + pad).ceil(), height);
    (right > left && bottom > top).then_some((left, top, right, bottom))
}
/// Union of two regions.
fn union(a: Option<Region>, b: Option<Region>) -> Option<Region> {
    match (a, b) {
        (Some(a), Some(b)) => Some((a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3))),
        (a, b) => a.or(b),
    }
}
/// LUCENT_VERIFY_BBOX: every non-transparent pixel must lie inside the computed region.
fn check_region(pix: &Pixmap, region: Region, kind: &str) -> Result<()> {
    let width = pix.width() as usize;
    for (i, px) in pix.data().chunks_exact(4).enumerate() {
        let (x, y) = ((i % width) as u32, (i / width) as u32);
        if px[3] != 0 && !(x >= region.0 && x < region.2 && y >= region.1 && y < region.3) {
            bail!("{kind} drew at ({x},{y}) outside its region {region:?}");
        }
    }
    Ok(())
}
/// Largest factor by which `ts` can stretch a unit vector.
fn max_scale(ts: Transform) -> f32 {
    let a = (ts.sx * ts.sx + ts.kx * ts.kx).sqrt();
    let b = (ts.ky * ts.ky + ts.sy * ts.sy).sqrt();
    a.max(b)
}
struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    /// Texture-only layout for film-shader effects.
    layout: wgpu::BindGroupLayout,
    /// Upload texture plus per-leaf opacity for the composite blit.
    blit_layout: wgpu::BindGroupLayout,
    opacity: wgpu::Buffer,
    info: Value,
    /// Reused upload texture and bind group; leaves only write their own region.
    source: Option<(u32, u32, wgpu::Texture, wgpu::BindGroup)>,
    staging: Vec<u8>,
    gpu_wait: Duration,
    pending: u32,
}
impl Gpu {
    fn new() -> Result<Self> {
        block_on(async {
            let instance = wgpu::Instance::default();
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    compatible_surface: None,
                    force_fallback_adapter: false,
                })
                .await
                .context("No wgpu adapter available")?;
            let adapter_info = adapter.get_info();
            let limits = adapter.limits();
            let (device, queue) = adapter
                .request_device(
                    &wgpu::DeviceDescriptor {
                        label: Some("Lucent"),
                        required_features: wgpu::Features::empty(),
                        required_limits: wgpu::Limits::downlevel_defaults()
                            .using_resolution(limits.clone()),
                        memory_hints: wgpu::MemoryHints::MemoryUsage,
                    },
                    None,
                )
                .await?;
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: None,
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                }],
            });
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: None,
                source: wgpu::ShaderSource::Wgsl(SHADER.into()),
            });
            let blit_layout =
                device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: None,
                    entries: &[
                        wgpu::BindGroupLayoutEntry {
                            binding: 0,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float {
                                    filterable: false,
                                },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 1,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Buffer {
                                ty: wgpu::BufferBindingType::Uniform,
                                has_dynamic_offset: false,
                                min_binding_size: None,
                            },
                            count: None,
                        },
                    ],
                });
            let opacity = device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: 16,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None,
                bind_group_layouts: &[&blit_layout],
                push_constant_ranges: &[],
            });
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: None,
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: "vs",
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: "fs",
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview: None,
                cache: None,
            });
            let hardware = !matches!(adapter_info.device_type, wgpu::DeviceType::Cpu);
            let info = json!({"available":true,"apiVersion":"0.1.0","features":["groups","transforms","clipping","paths","text","images","cameras","transitions","video","shader-wgsl","supersampling","motion-blur","svg"],"adapter":adapter_info.name,"driver":adapter_info.driver_info,"hardware":hardware,"maxDimensions":limits.max_texture_dimension_2d,"textureFormats":["rgba16float"],"workingBitDepth":16,"rasterization":"Rust tiny-skia/Cosmic Text; linear-light wgpu composition"});
            Ok(Self {
                device,
                queue,
                pipeline,
                layout,
                blit_layout,
                opacity,
                info,
                source: None,
                staging: Vec::new(),
                gpu_wait: Duration::ZERO,
                pending: 0,
            })
        })
    }
    fn texture(
        &self,
        width: u32,
        height: u32,
        usage: wgpu::TextureUsages,
        format: wgpu::TextureFormat,
    ) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        })
    }
    /// Upload `pixels` (premultiplied RGBA8, sRGB) for `region`; the blit
    /// shader linearises and applies the leaf opacity on the GPU.
    /// `region` bounds every non-transparent pixel; nothing outside it is read.
    fn composite(
        &mut self,
        target: &wgpu::Texture,
        data: &[u8],
        (width, height): (u32, u32),
        region: Region,
        opacity: f32,
    ) -> Result<()> {
        let (left, top, right, bottom) = region;
        if right <= left || bottom <= top {
            return Ok(());
        }
        let rw = right - left;
        let rh = bottom - top;
        self.staging.clear();
        self.staging.reserve((rw * rh * 4) as usize);
        for y in top..bottom {
            let row = ((y * width + left) * 4) as usize;
            self.staging
                .extend_from_slice(&data[row..row + (rw * 4) as usize]);
        }
        let mut op = [0u8; 16];
        op[..4].copy_from_slice(&opacity.to_le_bytes());
        self.queue.write_buffer(&self.opacity, 0, &op);
        let (w, h) = (width, height);
        if !matches!(&self.source, Some((sw, sh, ..)) if *sw == w && *sh == h) {
            let texture = self.texture(
                w,
                h,
                wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                wgpu::TextureFormat::Rgba8Unorm,
            );
            let view = texture.create_view(&Default::default());
            let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.blit_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: self.opacity.as_entire_binding(),
                    },
                ],
            });
            self.source = Some((w, h, texture, bind));
        }
        let (_, _, source, bind) = self.source.as_ref().unwrap();
        self.queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: source,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: left,
                    y: top,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            &self.staging,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(rw * 4),
                rows_per_image: Some(rh),
            },
            wgpu::Extent3d {
                width: rw,
                height: rh,
                depth_or_array_layers: 1,
            },
        );
        let mut encoder = self.device.create_command_encoder(&Default::default());
        let target_view = target.create_view(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_scissor_rect(left, top, rw, rh);
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, bind, &[]);
            pass.draw(0..3, 0..1);
        }
        // Submissions on one queue execute in order, and the next read() waits for
        // all of them, so there is no need to stall on every leaf.
        self.queue.submit(Some(encoder.finish()));
        // Letting hundreds of submissions and staging writes pile up before a poll is
        // far slower than waiting periodically, so drain the queue every few leaves.
        self.pending += 1;
        if self.pending >= SYNC_EVERY {
            self.pending = 0;
            let t = Instant::now();
            self.device.poll(wgpu::Maintain::Wait);
            self.gpu_wait += t.elapsed();
        }
        Ok(())
    }
    fn effect(&self, target: &wgpu::Texture, code: &str) -> Result<()> {
        self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Film shader"),
                source: wgpu::ShaderSource::Wgsl(code.into()),
            });
        let layout = self
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None,
                bind_group_layouts: &[&self.layout],
                push_constant_ranges: &[],
            });
        let pipeline = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: None,
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: "vs",
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: "fs",
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview: None,
                cache: None,
            });
        if let Some(e) = block_on(self.device.pop_error_scope()) {
            bail!("Shader validation failed: {e}");
        }
        let size = target.size();
        let source = self.texture(
            size.width,
            size.height,
            wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            wgpu::TextureFormat::Rgba16Float,
        );
        let mut commands = self.device.create_command_encoder(&Default::default());
        commands.copy_texture_to_texture(target.as_image_copy(), source.as_image_copy(), size);
        let source_view = source.create_view(&Default::default());
        let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&source_view),
            }],
        });
        let target_view = target.create_view(&Default::default());
        {
            let mut pass = commands.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit(Some(commands.finish()));
        self.device.poll(wgpu::Maintain::Wait);
        Ok(())
    }
    fn read(&self, target: &wgpu::Texture) -> Result<Vec<u8>> {
        let size = target.size();
        let row = (size.width * 8 + 255) & !255;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: (row * size.height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut commands = self.device.create_command_encoder(&Default::default());
        commands.copy_texture_to_buffer(
            target.as_image_copy(),
            wgpu::ImageCopyBuffer {
                buffer: &buffer,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(row),
                    rows_per_image: Some(size.height),
                },
            },
            size,
        );
        self.queue.submit(Some(commands.finish()));
        let (tx, rx) = mpsc::channel();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.device.poll(wgpu::Maintain::Wait);
        rx.recv()??;
        let bytes = buffer.slice(..).get_mapped_range();
        let mut out = Vec::with_capacity((size.width * size.height * 8) as usize);
        for line in bytes.chunks_exact(row as usize) {
            out.extend_from_slice(&line[..(size.width * 8) as usize]);
        }
        drop(bytes);
        buffer.unmap();
        Ok(out)
    }
}
pub(crate) struct Renderer {
    gpu: Gpu,
    fonts: FontSystem,
    swash: SwashCache,
    root: PathBuf,
    families: Vec<String>,
    prof: Profile,
    /// Frame-sized pixmap reused by every leaf; always fully transparent between leaves.
    scratch: Option<Pixmap>,
    /// Decoded still-image surfaces by canonical path.
    images: HashMap<PathBuf, Arc<Pixmap>>,
    /// Decoded video frames by (canonical path, presentation millisecond),
    /// capped at 64 entries; a looped clip would otherwise respawn ffmpeg
    /// for the same timestamps on every pass.
    video: HashMap<(PathBuf, i32), Arc<Pixmap>>,
    /// Pre-decoded short CFR clips by canonical path; None marks clips that
    /// failed the pre-decode criteria and keep per-timestamp seeks.
    clips: HashMap<PathBuf, Option<Arc<Clip>>>,
    svg: Svg,
    svg_fonts: FontDb,
    encode_lut: Vec<u16>,
    /// LUCENT_VERIFY_BBOX: assert that leaves never draw outside their computed region.
    verify_bbox: bool,
}
impl Renderer {
    pub(crate) fn capabilities(&self) -> &Value {
        &self.gpu.info
    }
    /// Fonts shared with scripts (`__measure_text`) so layout and drawing agree.
    pub(crate) fn font_db(&self) -> FontDb {
        self.svg_fonts.clone()
    }
    /// Pre-decoded clip for `source`, or None when the clip is long, VFR or
    /// otherwise unsuitable. Load failures also yield None so rendering falls
    /// back to per-timestamp seeks instead of failing.
    fn clip(&mut self, source: &PathBuf) -> Option<Arc<Clip>> {
        if let Some(hit) = self.clips.get(source) {
            return hit.clone();
        }
        let predecoded = load_clip(source).ok().map(Arc::new);
        self.clips.insert(source.clone(), predecoded.clone());
        predecoded
    }

    pub(crate) fn new(root: &Path, manifest: &Value) -> Result<Self> {
        let mut db = cosmic_text::fontdb::Database::new();
        let mut families = vec![];
        for font in manifest["fonts"].as_array().into_iter().flatten() {
            let file = safe_asset(root, font["file"].as_str().context("font file")?)?;
            db.load_font_data(fs::read(file)?);
            families.push(font["family"].as_str().context("font family")?.to_owned());
        }
        let fonts = FontSystem::new_with_locale_and_db("en-US".into(), db);
        let svg_fonts = svg::load_fonts(root, manifest)?;
        Ok(Self {
            svg: Svg::new(
                svg_fonts.clone(),
                families.first().map_or("Inter", String::as_str),
            ),
            svg_fonts,
            gpu: Gpu::new()?,
            fonts,
            swash: SwashCache::new(),
            root: root.to_owned(),
            families,
            prof: Profile {
                enabled: env::var_os("LUCENT_PROFILE").is_some(),
                ..Default::default()
            },
            scratch: None,
            images: HashMap::new(),
            video: HashMap::new(),
            clips: HashMap::new(),
            encode_lut: srgb_lut(),
            verify_bbox: env::var_os("LUCENT_VERIFY_BBOX").is_some(),
        })
    }
    fn node(
        &mut self,
        n: &Value,
        target: &wgpu::Texture,
        transform: Transform,
        opacity: f32,
        mask: Option<Rc<Mask>>,
    ) -> Result<()> {
        let size = target.size();
        let width = size.width;
        let height = size.height;
        let mut transform = transform;
        let translate = &n["translate"];
        transform = transform
            .pre_translate(
                translate[0].as_f64().unwrap_or(0.) as f32,
                translate[1].as_f64().unwrap_or(0.) as f32,
            )
            .pre_rotate(v(n, "rotate", 0.).to_degrees())
            .pre_scale(
                n["scale"][0].as_f64().unwrap_or(1.) as f32,
                n["scale"][1].as_f64().unwrap_or(1.) as f32,
            );
        let opacity = opacity * v(n, "opacity", 1.);
        let mut mask = mask;
        if let Some(clip) = n["clip"].as_array() {
            if clip.len() != 4 {
                bail!("clip needs x,y,width,height");
            }
            let rect = Rect::from_xywh(
                clip[0].as_f64().unwrap_or(0.) as f32,
                clip[1].as_f64().unwrap_or(0.) as f32,
                clip[2].as_f64().unwrap_or(0.) as f32,
                clip[3].as_f64().unwrap_or(0.) as f32,
            )
            .context("Invalid clip")?;
            let path = PathBuilder::from_rect(rect);
            if let Some(m) = &mut mask {
                Rc::make_mut(m).intersect_path(&path, FillRule::Winding, true, transform);
            } else {
                let mut m = Mask::new(width, height).context("mask allocation")?;
                m.fill_path(&path, FillRule::Winding, true, transform);
                mask = Some(Rc::new(m));
            }
        }
        let kind = n["type"].as_str().unwrap_or("group");
        if n.get("effect").is_some() {
            bail!("Use an explicit shader-wgsl node for native effects; portable effect capability unavailable");
        }
        if !["group", "camera"].contains(&kind) {
            if kind == "shader" {
                self.gpu.effect(
                    target,
                    n["wgsl"].as_str().context(
                        "shader needs WGSL with vs/fs entry points and texture binding 0",
                    )?,
                )?;
            } else if kind == "svg" {
                let markup = n["markup"].as_str().context("svg markup")?;
                if let Some(dir) = env::var_os("LUCENT_DUMP_SVG") {
                    // Debug aid: keep the last document of every frame for offline experiments.
                    let _ = fs::write(Path::new(&dir).join("last.svg"), markup);
                }
                let t_svg = Instant::now();
                let ts = sk::Transform::from_row(
                    transform.sx,
                    transform.ky,
                    transform.kx,
                    transform.sy,
                    transform.tx,
                    transform.ty,
                );
                let pixels = self.svg.render(markup, ts, width, height, n.get("grain"))?;
                self.prof.add("svg-render", t_svg);
                let t_composite = Instant::now();
                self.gpu.composite(
                    target,
                    pixels,
                    (width, height),
                    (0, 0, width, height),
                    opacity,
                )?;
                self.prof.add("composite", t_composite);
            } else {
                let t_alloc = Instant::now();
                let mut pix = match self.scratch.take() {
                    Some(p) if p.width() == width && p.height() == height => p,
                    _ => Pixmap::new(width, height).context("frame allocation")?,
                };
                self.prof.add("alloc", t_alloc);
                // Pixels this leaf can touch; everything else in `pix` stays transparent.
                let mut region: Option<Region> = None;
                let t_raster = Instant::now();
                let rgba = color(n["color"].as_str().unwrap_or("#ffffff"))?;
                let mut paint = Paint::default();
                paint.set_color_rgba8(rgba[0], rgba[1], rgba[2], rgba[3]);
                let x = v(n, "x", 0.);
                let y = v(n, "y", 0.);
                match kind {
                    "rect" => {
                        let r = Rect::from_xywh(x, y, v(n, "width", 0.), v(n, "height", 0.))
                            .context("Invalid rectangle")?;
                        pix.fill_rect(r, &paint, transform, mask.as_deref());
                        region = r
                            .transform(transform)
                            .and_then(|b| region_of(b, 2., width, height));
                    }
                    "circle" => {
                        let p = PathBuilder::from_circle(x, y, v(n, "radius", 0.))
                            .context("Invalid circle")?;
                        pix.fill_path(&p, &paint, FillRule::Winding, transform, mask.as_deref());
                        region = p
                            .bounds()
                            .transform(transform)
                            .and_then(|b| region_of(b, 2., width, height));
                    }
                    "path" => {
                        let mut p = PathBuilder::new();
                        for command in n["commands"].as_array().context("path commands")? {
                            let num = |i| command[i].as_f64().unwrap_or(0.) as f32;
                            match command[0].as_str().context("path command")? {
                                "M" => p.move_to(num(1), num(2)),
                                "L" => p.line_to(num(1), num(2)),
                                "Q" => p.quad_to(num(1), num(2), num(3), num(4)),
                                "C" => p.cubic_to(num(1), num(2), num(3), num(4), num(5), num(6)),
                                "Z" => p.close(),
                                other => bail!("Unknown path operation {other}"),
                            }
                        }
                        let p = p.finish().context("Empty path")?;
                        let stroked = n["stroke"].as_bool().unwrap_or(false);
                        // A stroke reaches at most a miter limit (4) of half widths past the
                        // outline, and hairlines are widened to a pixel.
                        let pad = if stroked {
                            2. + 2. * v(n, "strokeWidth", 1.) * max_scale(transform)
                        } else {
                            2.
                        };
                        region = p
                            .bounds()
                            .transform(transform)
                            .and_then(|b| region_of(b, pad, width, height));
                        if stroked {
                            pix.stroke_path(
                                &p,
                                &paint,
                                &Stroke {
                                    width: v(n, "strokeWidth", 1.),
                                    ..Default::default()
                                },
                                transform,
                                mask.as_deref(),
                            );
                        } else {
                            pix.fill_path(
                                &p,
                                &paint,
                                FillRule::Winding,
                                transform,
                                mask.as_deref(),
                            );
                        }
                    }
                    "text" => {
                        let t_shape = Instant::now();
                        let family = n["font"].as_str().unwrap_or("Inter");
                        if !self.families.iter().any(|f| f == family) {
                            bail!("Undeclared font {family}");
                        }
                        let text = n["text"].as_str().context("text")?;
                        let font_size = v(n, "size", 32.);
                        let mut buffer = Buffer::new(
                            &mut self.fonts,
                            Metrics::new(font_size, v(n, "lineHeight", font_size * 1.2)),
                        );
                        buffer.set_size(
                            &mut self.fonts,
                            n["wrapWidth"].as_f64().map(|x| x as f32),
                            None,
                        );
                        let mut features = cosmic_text::FontFeatures::new();
                        if n["kerning"] == false {
                            features.disable(cosmic_text::FeatureTag::KERNING);
                        }
                        if n["ligatures"] == false {
                            features.disable(cosmic_text::FeatureTag::STANDARD_LIGATURES);
                            features.disable(cosmic_text::FeatureTag::CONTEXTUAL_LIGATURES);
                        }
                        let attrs = Attrs::new()
                            .family(Family::Name(family))
                            .weight(cosmic_text::Weight(v(n, "weight", 400.) as u16))
                            .style(if n["style"] == "italic" {
                                cosmic_text::Style::Italic
                            } else {
                                cosmic_text::Style::Normal
                            })
                            .font_features(features);
                        buffer.set_text(&mut self.fonts, text, &attrs, Shaping::Advanced);
                        buffer.shape_until_scroll(&mut self.fonts, false);
                        if buffer.layout_runs().flat_map(|run| run.glyphs).any(|g| {
                            g.glyph_id == 0
                                || self.fonts.db().face(g.font_id).is_none_or(|face| {
                                    !face.families.iter().any(|(name, _)| {
                                        name == family
                                            || n["fallback"].as_array().is_some_and(|f| {
                                                f.iter().any(|v| v.as_str() == Some(name))
                                            })
                                    })
                                })
                        }) {
                            bail!("Missing glyph in embedded font {family}");
                        }
                        self.prof.add("text-shape", t_shape);
                        let first_baseline =
                            buffer.layout_runs().next().map(|r| r.line_y).unwrap_or(0.);
                        let align = n["align"].as_str().unwrap_or("left");
                        let line_width =
                            buffer.layout_runs().next().map(|r| r.line_w).unwrap_or(0.);
                        let anchor = if align == "center" {
                            -line_width / 2.
                        } else if align == "right" {
                            -line_width
                        } else {
                            0.
                        };
                        // cosmic-text emits one callback per pixel; batch
                        // consecutive same-colour pixels of a row into a
                        // single fill. Pixels are bit-identical to one
                        // fill per pixel, with far fewer raster calls.
                        let mut pending: Option<(i32, i32, i32, [u8; 4])> = None;
                        let mut flush = |pending: &mut Option<(i32, i32, i32, [u8; 4])>| {
                            if let Some((py, x0, x1, c)) = pending.take() {
                                let mut p = Paint::default();
                                p.set_color_rgba8(c[0], c[1], c[2], c[3]);
                                if let Some(r) = Rect::from_xywh(
                                    x + anchor + x0 as f32,
                                    y - first_baseline + py as f32,
                                    (x1 - x0) as f32,
                                    1.,
                                ) {
                                    pix.fill_rect(r, &p, transform, mask.as_deref());
                                    region = union(
                                        region,
                                        r.transform(transform).and_then(|b| {
                                            region_of(b, 2., width, height)
                                        }),
                                    );
                                }
                            }
                        };
                        buffer.draw(
                            &mut self.fonts,
                            &mut self.swash,
                            Color::rgba(rgba[0], rgba[1], rgba[2], rgba[3]),
                            |px, py, _w, _h, c| {
                                let c = [c.r(), c.g(), c.b(), c.a()];
                                match &mut pending {
                                    Some((ry, _, x1, rc))
                                        if *ry == py && *x1 == px && *rc == c =>
                                    {
                                        *x1 = px + 1
                                    }
                                    _ => {
                                        flush(&mut pending);
                                        pending = Some((py, px, px + 1, c));
                                    }
                                }
                            },
                        );
                        flush(&mut pending);
                    }
                    "image" | "video" => {
                        let file = n["src"].as_str().context("image/video src")?;
                        let source = safe_asset(&self.root, file)?;
                        let src: Arc<Pixmap> = if kind == "video" {
                            let time = v(n, "sourceTime", 0.);
                            // Short CFR clips are fully decoded once; the index
                            // is the first frame covering the timestamp.
                            if let Some(clip) = self.clip(&source) {
                                let len = clip.frames.len() as i64;
                                let idx = ((time as f64 * clip.fps).floor() as i64)
                                    .clamp(0, len - 1)
                                    as usize;
                                clip.frames[idx].clone()
                            } else {
                                // Identical presentation times reuse one decoded frame.
                                let ms = (time * 1000.).round() as i32;
                                if let Some(hit) = self.video.get(&(source.clone(), ms)) {
                                    hit.clone()
                                } else {
                                let mut decoded = None;
                                // A requested timestamp can fall just after a VFR clip's last
                                // presentation timestamp. Walk back by less than a frame on
                                // normal sources and use the last decodable frame at clip end.
                                for step in 0..32 {
                                    let seek =
                                        (time - step as f32 / 120.).max(0.).to_string();
                                    let output = std::process::Command::new("ffmpeg")
                                        .args(["-v", "error", "-ss", &seek, "-i"])
                                        .arg(&source)
                                        .args([
                                            "-frames:v",
                                            "1",
                                            "-f",
                                            "image2pipe",
                                            "-c:v",
                                            "png",
                                            "-",
                                        ])
                                        .output()?;
                                    if !output.status.success() {
                                        bail!(
                                            "Video decode failed at {time:.6}s: {}",
                                            String::from_utf8_lossy(&output.stderr)
                                        );
                                    }
                                    if !output.stdout.is_empty() {
                                        decoded = Some(
                                            image::load_from_memory(&output.stdout)?
                                                .into_rgba8(),
                                        );
                                        break;
                                    }
                                }
                                let pixmap = Arc::new(rgba_to_pixmap(decoded.context(
                                    "No video frame near the requested presentation timestamp",
                                )?)?);
                                if self.video.len() >= 64 {
                                    self.video.clear();
                                }
                                self.video.insert((source, ms), pixmap.clone());
                                pixmap
                            }
                            }
                        } else if let Some(hit) = self.images.get(&source) {
                            hit.clone()
                        } else {
                            let pixmap = Arc::new(rgba_to_pixmap(
                                image::open(&source)?.into_rgba8(),
                            )?);
                            self.images.insert(source, pixmap.clone());
                            pixmap
                        };
                        let (iw, ih) = (src.width(), src.height());
                        let it = transform.pre_translate(x, y).pre_scale(
                            v(n, "width", iw as f32) / iw as f32,
                            v(n, "height", ih as f32) / ih as f32,
                        );
                        pix.draw_pixmap(
                            0,
                            0,
                            src.as_ref().as_ref(),
                            &Default::default(),
                            it,
                            mask.as_deref(),
                        );
                        region = Rect::from_xywh(0., 0., iw as f32, ih as f32)
                            .and_then(|b| b.transform(it))
                            .and_then(|b| region_of(b, 2., width, height));
                    }
                    other => bail!("Unsupported native operation {other}"),
                }
                self.prof.add(
                    if kind == "text" {
                        "raster-text"
                    } else {
                        "raster-other"
                    },
                    t_raster,
                );
                if let Some(region) = region {
                    if self.verify_bbox {
                        check_region(&pix, region, kind)?;
                    }
                    let t_composite = Instant::now();
                    self.gpu
                        .composite(target, pix.data(), (width, height), region, opacity)?;
                    self.prof.add("composite", t_composite);
                    // Leave the scratch pixmap transparent for the next leaf.
                    let (left, top, right, bottom) = region;
                    let stride = width as usize * 4;
                    let data = pix.data_mut();
                    for y in top as usize..bottom as usize {
                        data[y * stride + left as usize * 4..y * stride + right as usize * 4]
                            .fill(0);
                    }
                } else if self.verify_bbox {
                    check_region(&pix, (0, 0, 0, 0), kind)?;
                }
                self.scratch = Some(pix);
            }
        }
        for child in n["children"].as_array().into_iter().flatten() {
            self.node(child, target, transform, opacity, mask.clone())?;
        }
        Ok(())
    }
    fn render_linear(
        &mut self,
        graph: &Value,
        width: u32,
        height: u32,
        design: &Value,
        fit: &str,
    ) -> Result<Vec<u8>> {
        if width == 0
            || height == 0
            || width > self.gpu.info["maxDimensions"].as_u64().unwrap_or(0) as u32
            || height > self.gpu.info["maxDimensions"].as_u64().unwrap_or(0) as u32
        {
            bail!("Requested dimensions exceed native adapter limit");
        }
        let target = self.gpu.texture(
            width,
            height,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            wgpu::TextureFormat::Rgba16Float,
        );
        let view = target.create_view(&Default::default());
        let bg = color(graph["background"].as_str().unwrap_or("#000000"))?;
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: linear(bg[0] as f32 / 255.) as f64,
                            g: linear(bg[1] as f32 / 255.) as f64,
                            b: linear(bg[2] as f32 / 255.) as f64,
                            a: 1.,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
        }
        self.gpu.queue.submit(Some(encoder.finish()));
        let dw = v(design, "width", width as f32);
        let dh = v(design, "height", height as f32);
        let scale = if fit == "fill" {
            (width as f32 / dw).max(height as f32 / dh)
        } else {
            (width as f32 / dw).min(height as f32 / dh)
        };
        let transform = if fit == "stretch" {
            Transform::from_scale(width as f32 / dw, height as f32 / dh)
        } else {
            Transform::from_translate(
                (width as f32 - dw * scale) / 2.,
                (height as f32 - dh * scale) / 2.,
            )
            .pre_scale(scale, scale)
        };
        self.node(graph, &target, transform, 1., None)?;
        let t_read = Instant::now();
        let bytes = self.gpu.read(&target)?;
        self.prof.add("readback", t_read);
        Ok(bytes)
    }
    pub(crate) fn render(
        &mut self,
        graph: &Value,
        width: u32,
        height: u32,
        design: &Value,
        fit: &str,
    ) -> Result<Vec<u8>> {
        let bytes = self.render_linear(graph, width, height, design, fit)?;
        let mut values = vec![0f32; (width * height * 3) as usize];
        for (pixel, half) in values.chunks_exact_mut(3).zip(bytes.chunks_exact(8)) {
            for c in 0..3 {
                pixel[c] = f16::from_le_bytes([half[c * 2], half[c * 2 + 1]]).to_f32();
            }
        }
        encode_frame(&values, width, height)
    }
    /// Preview-only fast path: the same linear working pixels as `render`,
    /// mapped through the same sRGB transfer to 8-bit for direct display.
    /// Skips the 16-bit PNG encode (and the caller's PNG decode); export
    /// pixels are untouched.
    pub(crate) fn preview(
        &mut self,
        graph: &Value,
        width: u32,
        height: u32,
        design: &Value,
        fit: &str,
    ) -> Result<Vec<u8>> {
        let bytes = self.render_linear(graph, width, height, design, fit)?;
        let t_lut = Instant::now();
        let mut out = Vec::with_capacity((width as usize) * (height as usize) * 4);
        for px in bytes.chunks_exact(8) {
            for c in 0..3 {
                let bits = u16::from_le_bytes([px[c * 2], px[c * 2 + 1]]);
                out.push((self.encode_lut[bits as usize] >> 8) as u8);
            }
            out.push(255);
        }
        self.prof.add("preview-lut", t_lut);
        Ok(out)
    }
    pub(crate) fn sampled(
        &mut self,
        graphs: &[Value],
        width: u32,
        height: u32,
        design: &Value,
        fit: &str,
        ss: u32,
    ) -> Result<Vec<u8>> {
        if graphs.is_empty()
            || ss == 0
            || ss > 4
            || u64::from(width) * u64::from(height) * u64::from(ss * ss) > 33_554_432
        {
            bail!("Native sampling exceeds the 32-megapixel working-frame limit");
        }
        if graphs.len() == 1 && ss == 1 {
            let t_linear = Instant::now();
            let bytes = self.render_linear(&graphs[0], width, height, design, fit)?;
            self.prof.add("render_linear+readback", t_linear);
            let t_encode = Instant::now();
            let png = encode_frame_f16(&bytes, &self.encode_lut, width, height);
            self.prof.add("png-encode", t_encode);
            return png;
        }
        let mut sum = vec![0f32; (width * height * 3) as usize];
        let sw = width * ss;
        let weight = 1.0 / (graphs.len() as f32 * (ss * ss) as f32);
        for graph in graphs {
            let t_linear = Instant::now();
            let bytes = self.render_linear(graph, sw, height * ss, design, fit)?;
            self.prof.add("render_linear+readback", t_linear);
            let t_accumulate = Instant::now();
            for y in 0..height * ss {
                for x in 0..sw {
                    let src = ((y * sw + x) * 8) as usize;
                    let dst = (((y / ss) * width + x / ss) * 3) as usize;
                    for c in 0..3 {
                        sum[dst + c] +=
                            f16::from_le_bytes([bytes[src + c * 2], bytes[src + c * 2 + 1]])
                                .to_f32()
                                * weight;
                    }
                }
            }
            self.prof.add("accumulate", t_accumulate);
        }
        let t_encode = Instant::now();
        let png = encode_frame(&sum, width, height);
        self.prof.add("png-encode", t_encode);
        png
    }
    pub(crate) fn flush_profile(&mut self) {
        if self.prof.enabled {
            eprintln!("gpu-wait={:.1}ms", self.gpu.gpu_wait.as_secs_f64() * 1e3);
        }
        self.gpu.gpu_wait = Duration::ZERO;
        self.prof.flush();
    }
}
fn encode_frame(values: &[f32], width: u32, height: u32) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(values.len() / 3 * 4);
    for values in values.chunks_exact(3) {
        out.extend(values.iter().map(|v| (encoded(*v) * 65535.).round() as u16));
        out.push(65535);
    }
    png16(&out, width, height)
}
/// Encode straight from linear f16 RGBA bytes. Equivalent to `encode_frame` on a single
/// unscaled sample, because every value is exactly an f16 and `lut` maps each of the
/// 65,536 bit patterns through the same sRGB encoding.
fn encode_frame_f16(bytes: &[u8], lut: &[u16], width: u32, height: u32) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for px in bytes.chunks_exact(8) {
        for c in 0..3 {
            out.push(lut[u16::from_le_bytes([px[c * 2], px[c * 2 + 1]]) as usize]);
        }
        out.push(65535);
    }
    png16(&out, width, height)
}
fn srgb_lut() -> Vec<u16> {
    (0..=u16::MAX)
        .map(|bits| (encoded(f16::from_bits(bits).to_f32()) * 65535.).round() as u16)
        .collect()
}
/// Frames are intermediate data (cached, decoded again by the encoder), so favour speed
/// over file size; the pixels are identical at any compression level.
fn png16(samples: &[u16], width: u32, height: u32) -> Result<Vec<u8>> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;
    let mut png = io::Cursor::new(vec![]);
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Sub).write_image(
        bytemuck::cast_slice(samples),
        width,
        height,
        image::ExtendedColorType::Rgba16,
    )?;
    Ok(png.into_inner())
}
pub fn capabilities() -> Result<()> {
    println!("{}", Gpu::new()?.info);
    Ok(())
}

pub(crate) fn validate_native_scenes(scenes: &Value, capabilities: &Value) -> Result<()> {
    let supported = capabilities["features"]
        .as_array()
        .context("native renderer features")?;
    for scene in scenes.as_array().context("film scenes")? {
        let id = scene["id"].as_str().unwrap_or("unknown");
        if scene["renderer"] == "browser-only" {
            bail!("Scene {id} is browser-only and cannot run in the native renderer");
        }
        for required in scene["requires"].as_array().into_iter().flatten() {
            let required = required.as_str().context("scene capability name")?;
            if !supported
                .iter()
                .any(|feature| feature.as_str() == Some(required))
            {
                bail!("Scene {id} requires unsupported native capability: {required}");
            }
        }
    }
    Ok(())
}

pub fn server(bundle: &str, manifest: &str) -> Result<()> {
    let manifest_path = Path::new(manifest).canonicalize()?;
    let root = manifest_path.parent().context("project root")?;
    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    let mut renderer = Renderer::new(root, &manifest)?;
    let (_runtime, context, deadline) = vm(bundle, Some(renderer.font_db()))?;

    let timeline=context.with(|ctx|ctx.eval::<String,_>("JSON.stringify({total:__film.duration,scenes:__film.scenes.map(s=>({id:s.id,start:s.start,dur:s.duration,renderer:s.renderer,requires:s.requires,dependencies:s.dependencies,caps:s.caps,implementation:String(s.frame)}))})"))?;
    let timeline_value: Value = serde_json::from_str(&timeline)?;
    validate_native_scenes(&timeline_value["scenes"], &renderer.gpu.info)?;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let header = json!({"timeline":timeline_value,"capabilities":renderer.gpu.info});
    let bytes = serde_json::to_vec(&header)?;
    stdout.write_all(&(bytes.len() as u32).to_le_bytes())?;
    stdout.write_all(&bytes)?;
    stdout.flush()?;
    for line in stdin.lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let time = request["time"].as_f64().context("timestamp")?;
        if !time.is_finite() {
            bail!("Invalid timestamp");
        }
        let mb = request["mb"].as_u64().unwrap_or(1) as u32;
        let ss = request["ss"].as_u64().unwrap_or(1) as u32;
        let fps = request["fps"].as_f64().unwrap_or(30.);
        let shutter = request["shutter"].as_f64().unwrap_or(0.5);
        if mb == 0
            || mb > 32
            || !fps.is_finite()
            || fps <= 0.
            || !shutter.is_finite()
            || !(0.0..=1.0).contains(&shutter)
        {
            bail!("Invalid sampling settings");
        }
        let total = context.with(|ctx| ctx.eval::<f64, _>("__film.duration"))?;
        let mut graphs = Vec::new();
        for sample in 0..mb {
            let t = (time
                + if mb > 1 {
                    (sample as f64 / (mb - 1) as f64 - 0.5) * shutter / fps
                } else {
                    0.
                })
            .clamp(0., (total - 1e-6).max(0.));
            *deadline.lock().unwrap() = Instant::now() + Duration::from_secs(5);
            let script = format!("JSON.stringify(__graph({t}))");
            let t_js = Instant::now();
            let json = context.with(|ctx| ctx.eval::<String, _>(script))?;
            renderer.prof.add("js-frame", t_js);
            let t_parse = Instant::now();
            let mut graph: Value = serde_json::from_str(&json)?;
            renderer.prof.add("graph-parse", t_parse);
            prepare_clips(&mut graph, t as f32)?;
            graphs.push(graph);
        }
        let png = renderer.sampled(
            &graphs,
            request["width"].as_u64().context("width")? as u32,
            request["height"].as_u64().context("height")? as u32,
            &manifest["design"],
            request["fit"].as_str().unwrap_or("fit"),
            ss,
        )?;
        renderer.flush_profile();;
        stdout.write_all(&(png.len() as u32).to_le_bytes())?;
        stdout.write_all(&png)?;
        stdout.flush()?;
    }
    Ok(())
}

pub(crate) fn prepare_clips(n: &mut Value, time: f32) -> Result<()> {
    let time = v(n, "time", time);
    if n["type"] == "video" {
        let rate = v(n, "rate", 1.);
        if !rate.is_finite() || rate <= 0. {
            bail!("Video rate must be positive");
        }
        let mut local = time.max(0.) * rate;
        if n["loop"].as_bool().unwrap_or(false) {
            let duration = v(n, "duration", 0.);
            if duration <= 0. {
                bail!("Loop requires a positive video duration");
            }
            local = local.rem_euclid(duration);
        }
        n["sourceTime"] = json!(v(n, "trim", 0.) + local);
    }
    for child in n["children"].as_array_mut().into_iter().flatten() {
        prepare_clips(child, time)?;
    }
    Ok(())
}

pub(crate) fn vm(
    bundle: &str,
    fonts: Option<FontDb>,
) -> Result<(Runtime, Context, Arc<Mutex<Instant>>)> {
    let runtime = Runtime::new()?;
    let deadline = Arc::new(Mutex::new(Instant::now() + Duration::from_secs(5)));
    let interrupt = deadline.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        Instant::now() > *interrupt.lock().unwrap()
    })));
    runtime.set_memory_limit(128 * 1024 * 1024);
    runtime.set_max_stack_size(1024 * 1024);
    let context = Context::full(&runtime)?;
    context.with(|ctx| -> rquickjs::Result<()> {
        ctx.eval::<(), _>(
            "Math.random=()=>{throw new Error('Use seeded engine RNG')};globalThis.Date=undefined;",
        )?;
        if let Some(fonts) = fonts {
            let glyph_fonts = fonts.clone();
            ctx.globals().set(
                "__has_glyph",
                rquickjs::Function::new(ctx.clone(), move |family: String, code: u32| {
                    svg::has_glyph(&glyph_fonts, &family, code)
                }),
            )?;
            // getComputedTextLength for scripts that lay text out themselves.
            ctx.globals().set(
                "__measure_text",
                rquickjs::Function::new(
                    ctx.clone(),
                    move |text: String, family: String, weight: f64, size: f64, spacing: f64| {
                        svg::measure_text(
                            &fonts,
                            &text,
                            &family,
                            weight as u16,
                            size as f32,
                            spacing as f32,
                        ) as f64
                    },
                ),
            )?;
        }
        ctx.eval::<(), _>(fs::read_to_string(bundle).unwrap_or_default())?;
        ctx.eval::<(), _>(
            "globalThis.__film=FilmBundle.default;globalThis.__graph=FilmBundle.graph;",
        )
    })?;
    Ok((runtime, context, deadline))
}
