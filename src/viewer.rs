use crate::native::{prepare_clips, validate_native_scenes, vm, Renderer};
use anyhow::{Context as _, Result};
use rquickjs::{Context, Runtime};
use serde_json::Value;
use std::{
    fs,
    io::BufReader,
    num::NonZeroU32,
    path::Path,
    rc::Rc,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use winit::{
    application::ApplicationHandler,
    event::{ElementState, WindowEvent},
    event_loop::{ActiveEventLoop, EventLoop},
    keyboard::{KeyCode, PhysicalKey},
    window::{Window, WindowId},
};
struct Viewer {
    window: Option<Rc<Window>>,
    surface: Option<softbuffer::Surface<Rc<Window>, Rc<Window>>>,
    renderer: Renderer,
    _runtime: Runtime,
    context: Context,
    deadline: Arc<Mutex<Instant>>,
    manifest: Value,
    total: f64,
    time: f64,
    epoch: Instant,
    playing: bool,
    show_captions: bool,
    shift: bool,
    volume: f32,
    sink: Option<rodio::Sink>,
    _audio: Option<rodio::OutputStream>,
    last_frame: i64,
    chapters: Vec<f64>,
    error: Option<String>,
}
impl Viewer {
    fn seek(&mut self, t: f64) {
        self.time = t.clamp(0., (self.total - 0.00001).max(0.));
        self.epoch = Instant::now() - Duration::from_secs_f64(self.time);
        if let Some(s) = &self.sink {
            if let Err(e) = s.try_seek(Duration::from_secs_f64(self.time)) {
                self.error = Some(format!("Audio seek failed: {e}"));
            }
        }
        self.last_frame = -1;
    }
    fn draw(&mut self) -> Result<()> {
        if self.playing {
            self.time = if let Some(s) = &self.sink {
                s.get_pos().as_secs_f64()
            } else {
                self.epoch.elapsed().as_secs_f64()
            };
            if self.time >= self.total {
                self.playing = false;
                self.time = self.total - 0.00001;
                if let Some(s) = &self.sink {
                    s.pause();
                }
            }
        }
        let frame = (self.time * 60.) as i64;
        if frame == self.last_frame {
            return Ok(());
        }
        self.last_frame = frame;
        *self.deadline.lock().unwrap() = Instant::now() + Duration::from_secs(5);
        let script = format!("JSON.stringify(__graph({}, 30))", self.time);
        let mut graph: Value =
            serde_json::from_str(&self.context.with(|ctx| ctx.eval::<String, _>(script))?)?;
        prepare_clips(&mut graph, self.time as f32)?;
        let window = self.window.as_ref().context("window")?;
        let size = window.inner_size();
        if size.width == 0 || size.height == 0 {
            return Ok(());
        }
        let rgba8 = self.renderer.preview(
            &graph,
            size.width,
            size.height,
            &self.manifest["design"],
            "fit",
        )?;
        let surface = self.surface.as_mut().context("surface")?;
        surface
            .resize(
                NonZeroU32::new(size.width).unwrap(),
                NonZeroU32::new(size.height).unwrap(),
            )
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let mut buffer = surface.buffer_mut().map_err(|e| anyhow::anyhow!("{e}"))?;
        for (dst, p) in buffer.iter_mut().zip(rgba8.chunks_exact(4)) {
            *dst = ((p[0] as u32) << 16) | ((p[1] as u32) << 8) | p[2] as u32;
        }
        buffer.present().map_err(|e| anyhow::anyhow!("{e}"))?;
        let caption = if self.show_captions {
            self.context.with(|ctx|ctx.eval::<String,_>(format!("(()=>{{const t={};const s=__film.scenes.findLast(s=>t>=s.start);return s?.caps?.findLast(c=>t-s.start>=c[0])?.[1]||'';}})()",self.time))).unwrap_or_default()
        } else {
            String::new()
        };
        window.set_title(&format!(
            "{} | {:.1}/{:.1}s | {} | {}",
            self.manifest["id"].as_str().unwrap_or("Film"),
            self.time,
            self.total,
            if self.playing { "Playing" } else { "Paused" },
            caption
        ));
        Ok(())
    }
}
impl ApplicationHandler for Viewer {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        match event_loop.create_window(Window::default_attributes().with_title("Lucent | Space: play, arrows: frame, Shift arrows: 5s, PageUp/Down: chapter, C: captions, F: fullscreen").with_inner_size(winit::dpi::LogicalSize::new(1280.,720.))){Ok(window)=>{let window=Rc::new(window);match softbuffer::Context::new(window.clone()).and_then(|ctx|softbuffer::Surface::new(&ctx,window.clone())){Ok(surface)=>{self.surface=Some(surface);self.window=Some(window);},Err(e)=>{self.error=Some(e.to_string());event_loop.exit();}}},Err(e)=>{self.error=Some(e.to_string());event_loop.exit();}}
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::ModifiersChanged(m) => self.shift = m.state().shift_key(),
            WindowEvent::Resized(_) => self.last_frame = -1,
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                if let PhysicalKey::Code(key) = event.physical_key {
                    match key {
                        KeyCode::Escape => event_loop.exit(),
                        KeyCode::Space => {
                            self.playing = !self.playing;
                            self.epoch = Instant::now() - Duration::from_secs_f64(self.time);
                            if let Some(s) = &self.sink {
                                if self.playing {
                                    s.play()
                                } else {
                                    s.pause()
                                }
                            }
                        }
                        KeyCode::ArrowRight => {
                            self.seek(self.time + if self.shift { 5. } else { 1. / 60. })
                        }
                        KeyCode::ArrowLeft => {
                            self.seek(self.time - if self.shift { 5. } else { 1. / 60. })
                        }
                        KeyCode::PageDown => {
                            let t = self
                                .chapters
                                .iter()
                                .copied()
                                .find(|t| *t > self.time + 0.001)
                                .unwrap_or(self.total);
                            self.seek(t);
                        }
                        KeyCode::PageUp => {
                            let t = self
                                .chapters
                                .iter()
                                .copied()
                                .filter(|t| *t < self.time - 0.001)
                                .last()
                                .unwrap_or(0.);
                            self.seek(t);
                        }
                        KeyCode::KeyC => {
                            self.show_captions = !self.show_captions;
                            self.last_frame = -1;
                        }
                        KeyCode::KeyF => {
                            if let Some(w) = &self.window {
                                w.set_fullscreen(if w.fullscreen().is_some() {
                                    None
                                } else {
                                    Some(winit::window::Fullscreen::Borderless(None))
                                });
                            }
                        }
                        KeyCode::Equal | KeyCode::Minus => {
                            self.volume = (self.volume
                                + if key == KeyCode::Equal { 0.05 } else { -0.05 })
                            .clamp(0., 1.);
                            if let Some(s) = &self.sink {
                                s.set_volume(self.volume);
                            }
                        }
                        _ => {}
                    }
                }
            }
            WindowEvent::RedrawRequested => {
                if let Err(e) = self.draw() {
                    self.error = Some(e.to_string());
                    event_loop.exit();
                }
            }
            _ => {}
        }
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if let Some(w) = &self.window {
            w.request_redraw();
        }
        event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(
            Instant::now() + Duration::from_millis(16),
        ));
    }
}
pub fn play(bundle: &str, manifest_file: &str) -> Result<()> {
    let manifest_path = Path::new(manifest_file).canonicalize()?;
    let root = manifest_path.parent().context("root")?;
    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    if manifest["renderer"] == "browser-only" {
        anyhow::bail!("Browser-only film cannot use the native viewer");
    }
    let renderer = Renderer::new(root, &manifest)?;
    let (runtime, context, deadline) = vm(bundle, Some(renderer.font_db()))?;
    let scenes: Value = serde_json::from_str(&context.with(|ctx| {
        ctx.eval::<String, _>(
            "JSON.stringify(__film.scenes.map(s=>({id:s.id,renderer:s.renderer,requires:s.requires})))",
        )
    })?)?;
    validate_native_scenes(&scenes, renderer.capabilities())?;
    let total = context.with(|ctx| ctx.eval::<f64, _>("__film.duration"))?;
    let chapters: Vec<f64> = serde_json::from_str(
        &context
            .with(|ctx| ctx.eval::<String, _>("JSON.stringify(__film.scenes.map(s=>s.start))"))?,
    )?;
    let mut sink = None;
    let mut audio = None;
    let generated_mix = root.join("out").join(format!(
        "{}-audio.wav",
        manifest["id"].as_str().unwrap_or("film")
    ));
    let assembled_narration = root.join("out/tts/narration.wav");
    let declared_audio = manifest["audio"]["file"]
        .as_str()
        .map(|file| root.join(file));
    let playback_audio = if generated_mix.is_file() {
        Some(generated_mix)
    } else if assembled_narration.is_file() {
        Some(assembled_narration)
    } else {
        declared_audio.filter(|file| file.is_file())
    };
    if let Some(file) = playback_audio {
        let stream = rodio::OutputStreamBuilder::open_default_stream()?;
        let s = rodio::Sink::connect_new(stream.mixer());
        s.append(rodio::Decoder::try_from(BufReader::new(fs::File::open(
            file,
        )?))?);
        s.set_volume(0.85);
        s.pause();
        sink = Some(s);
        audio = Some(stream);
    }
    let mut app = Viewer {
        window: None,
        surface: None,
        renderer,
        _runtime: runtime,
        context,
        deadline,
        manifest,
        total,
        time: 0.,
        epoch: Instant::now(),
        playing: false,
        show_captions: true,
        shift: false,
        volume: 0.85,
        sink,
        _audio: audio,
        last_frame: -1,
        chapters,
        error: None,
    };
    let events = EventLoop::new()?;
    events.run_app(&mut app)?;
    if let Some(e) = app.error {
        anyhow::bail!(e);
    }
    Ok(())
}
/// Headless preview benchmark: no window, no vsync. Runs `preview` (viewing)
/// and `render` (export PNG) over the same timestamps so the fast path stays
/// honest, then checks frame 0 agrees within 1 LSB per channel.
pub fn preview_bench(
    bundle: &str,
    manifest_file: &str,
    frames: usize,
    width: u32,
    height: u32,
) -> Result<()> {
    let manifest_path = Path::new(manifest_file).canonicalize()?;
    let root = manifest_path.parent().context("root")?;
    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    if manifest["renderer"] == "browser-only" {
        anyhow::bail!("Browser-only film cannot use the native preview benchmark");
    }
    let mut renderer = Renderer::new(root, &manifest)?;
    let (_runtime, context, deadline) = vm(bundle, Some(renderer.font_db()))?;
    let scenes: Value = serde_json::from_str(&context.with(|ctx| {
        ctx.eval::<String, _>(
            "JSON.stringify(__film.scenes.map(s=>({id:s.id,renderer:s.renderer,requires:s.requires})))",
        )
    })?)?;
    validate_native_scenes(&scenes, renderer.capabilities())?;
    let total = context.with(|ctx| ctx.eval::<f64, _>("__film.duration"))?;
    if !total.is_finite() || total <= 0. {
        anyhow::bail!("Invalid film duration");
    }
    if frames == 0 || width == 0 || height == 0 {
        anyhow::bail!("preview-bench needs frames, width and height");
    }
    let fps = 30.;
    let timestamp = |i: usize| {
        ((i as f64 / fps) % total.max(1e-3)).clamp(0., (total - 1e-6).max(0.))
    };
    let graph_at = |t: f64| -> Result<Value> {
        *deadline.lock().unwrap() = Instant::now() + Duration::from_secs(5);
        let json =
            context.with(|ctx| ctx.eval::<String, _>(format!("JSON.stringify(__graph({t}))")))?;
        let mut graph: Value = serde_json::from_str(&json)?;
        prepare_clips(&mut graph, t as f32)?;
        Ok(graph)
    };
    // Warmup: pipeline compile plus hot image/video caches.
    for i in 0..3.min(frames) {
        let graph = graph_at(timestamp(i))?;
        let _ = renderer.preview(&graph, width, height, &manifest["design"], "fit")?;
    }
    renderer.flush_profile();
    let start = Instant::now();
    let mut js_secs = 0f64;
    for i in 0..frames {
        let t = Instant::now();
        let graph = graph_at(timestamp(i))?;
        js_secs += t.elapsed().as_secs_f64();
        let _ = renderer.preview(&graph, width, height, &manifest["design"], "fit")?;
    }
    let preview_secs = start.elapsed().as_secs_f64();
    let preview_js = js_secs;
    renderer.flush_profile();
    let start = Instant::now();
    let mut js_secs = 0f64;
    for i in 0..frames {
        let t = Instant::now();
        let graph = graph_at(timestamp(i))?;
        js_secs += t.elapsed().as_secs_f64();
        let _ = renderer.sampled(&[graph], width, height, &manifest["design"], "fit", 1)?;
    }
    let export_secs = start.elapsed().as_secs_f64();
    let export_js = js_secs;
    renderer.flush_profile();
    // Frame 0 agreement: same transfer, 8-bit truncation, so at most 1 LSB.
    let graph = graph_at(timestamp(0))?;
    let shown = renderer.preview(&graph, width, height, &manifest["design"], "fit")?;
    let png = renderer.render(&graph, width, height, &manifest["design"], "fit")?;
    let exported = image::load_from_memory(&png)?.into_rgba16();
    let mut max_diff: u8 = 0;
    for (a, p) in exported.pixels().zip(shown.chunks_exact(4)) {
        for c in 0..3 {
            max_diff = max_diff.max(((a[c] >> 8) as u8).abs_diff(p[c]));
        }
    }
    println!(
        "{}",
        serde_json::json!({
            "schemaVersion": 1,
            "film": manifest["id"],
            "frames": frames,
            "resolution": [width, height],
            "cachesHot": true,
            "previewSecs": preview_secs,
            "previewFps": frames as f64 / preview_secs,
            "previewJsParseSecs": preview_js,
            "exportSecs": export_secs,
            "exportFps": frames as f64 / export_secs,
            "exportJsParseSecs": export_js,
            "frame0MaxLsbDiff": max_diff,
        })
    );
    Ok(())
}
