const $ = (id) => document.getElementById(id),
  p = await (await fetch("/api/project")).json(),
  iframe = $("film"),
  audio = $("audio"),
  app = $("app");
const store = {
  get(key, fallback) {
    try {
      return localStorage.getItem("lucent." + key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("lucent." + key, value);
    } catch {}
  },
};
let timeline,
  time = 0,
  playing = false,
  rate = 1,
  last = performance.now(),
  caps = store.get("captions", "1") === "1",
  busy = false,
  lastFrame = -1,
  marks = [];
const svg = (d, extra = "") =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/>${extra}</svg>`;
const label = (text) =>
  `<text x="12" y="15.4" font-size="7.2" font-weight="700" text-anchor="middle" font-family="system-ui,sans-serif" fill="currentColor">${text}</text>`;
const ICON = {
  play: svg("M8 5v14l11-7z"),
  pause: svg("M6 5h4v14H6zM14 5h4v14h-4z"),
  prev: svg("M6 5h2v14H6zM20 5v14L9 12z"),
  next: svg("M16 5h2v14h-2zM4 5l11 7L4 19z"),
  back: svg("M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z", label("10")),
  fwd: svg("M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z", label("10")),
  cc: svg(
    "M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM11 11H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1z",
  ),
  volume: svg(
    "M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z",
  ),
  muted: svg(
    "M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5zM19 12c0 .9-.2 1.8-.5 2.6l1.5 1.5A8.8 8.8 0 0 0 21 12c0-4.3-3-7.9-7-8.8v2.1c2.9.9 5 3.5 5 6.7zM4.3 3L3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3c-.7.5-1.4.9-2.3 1.1v2.1c1.4-.3 2.6-1 3.7-1.9L19.7 21 21 19.7l-9-9zM12 4L9.9 6.1 12 8.2z",
  ),
  full: svg(
    "M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z",
  ),
  exit: svg(
    "M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z",
  ),
};
for (const [id, icon] of [
  ["play", "play"],
  ["prev", "prev"],
  ["next", "next"],
  ["back", "back"],
  ["fwd", "fwd"],
  ["captions", "cc"],
  ["mute", "volume"],
  ["fullscreen", "full"],
])
  $(id).innerHTML = ICON[icon];
// Astra films draw their captions into the frame; for those the Captions button toggles the film's
// own (a class its stylesheet understands) and the separate caption band is not needed.
const captionsInFilm = p.adapter === "astra";
function applyCaptions() {
  $("caption").hidden = captionsInFilm;
  $("caption").classList.toggle("off", !caps);
  try {
    iframe.contentDocument?.body.classList.toggle("hide-captions", !caps);
  } catch {}
}
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fmt = (t) => {
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
const setStatus = (text, error = false) => {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
};
const setVeil = (text, error = false) => {
  $("veil").hidden = !text;
  $("veil").classList.toggle("error", error);
  $("veiltext").textContent = text || "";
};
// Settings come back from the last session.
$("fps").value = store.get("fps", "60");
$("speed").value = store.get("speed", "1");
rate = Number($("speed").value) || 1;
audio.volume = Number(store.get("volume", "0.85"));
audio.muted = store.get("muted", "0") === "1";
$("volume").value = audio.volume;
$("captions").setAttribute("aria-pressed", String(caps));
const syncMute = () => {
  $("mute").innerHTML =
    audio.muted || audio.volume === 0 ? ICON.muted : ICON.volume;
  $("mute").setAttribute("aria-label", audio.muted ? "Unmute" : "Mute");
  $("volume").value = audio.muted ? 0 : audio.volume;
};
syncMute();
const pacing =
  new URLSearchParams(location.search).get("pacing") || "narration";
if (p.pacing) {
  $("pacing").hidden = false;
  for (const name of Object.keys(p.pacing))
    $("pacing").add(
      new Option(`${name[0].toUpperCase()}${name.slice(1)} pacing`, name),
    );
  $("pacing").value = pacing;
  $("pacing").onchange = (e) => {
    const url = new URL(location.href);
    url.searchParams.set("pacing", e.target.value);
    location.href = url;
  };
  if (!p.pacing[pacing]) throw Error("Unknown pacing");
  p.query = { ...p.query, pacing };
  p.audio = { ...p.audio, file: p.pacing[pacing].audio };
}
const params = new URLSearchParams({
  ...p.query,
  ss: "1",
  w: p.design.width,
  h: p.design.height,
  render: "1",
});
setVeil("Loading film…");
iframe.src =
  p.adapter === "scenegraph"
    ? "/engine/web/graph.html"
    : `/${p.entry}?${params}`;
iframe.onload = async () => {
  try {
    const w = iframe.contentWindow;
    const wait = async () => {
      for (let i = 0; i < 600; i++) {
        if (w.__ready || w.READY || p.adapter === "scenegraph") return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error("The film took too long to load.");
    };
    await wait();
    if (p.adapter === "scenegraph") {
      const { GraphRenderer, loadFonts } = await w.eval(
        "import('/engine/web/graph.js')",
      );
      await loadFonts(p);
      const mod = await w.eval("import('/__film.js')"),
        c = w.document.getElementById("c");
      c.width = p.design.width;
      c.height = p.design.height;
      const r = new GraphRenderer(c, mod.default, p);
      timeline = {
        total: mod.default.duration,
        scenes: mod.default.scenes.map((s) => ({ ...s, dur: s.duration })),
      };
      w.__viewerSeek = async (t) => r.draw(await r.prepare(t, Number($("fps").value) || 30));
    } else if (p.adapter === "astra") {
      timeline = w.TL;
      w.__viewerSeek = (t) =>
        w.__seek(t, Math.round(t * Number($("fps").value)));
    } else {
      timeline = { total: w.FILMDATA.duration, scenes: w.FILMDATA.scenes };
      w.__viewerSeek = async (t) => {
        if (w.prepFrame) await w.prepFrame([t]);
        w.renderFrame(t);
      };
    }
    const target =
      p.adapter === "astra"
        ? w.document.getElementById("stage")
        : w.document.getElementById("c");
    const fit = () => {
      const scale = Math.min(
        iframe.clientWidth / p.design.width,
        iframe.clientHeight / p.design.height,
      );
      target.style.transformOrigin = "0 0";
      target.style.position = "absolute";
      target.style.left = `${(iframe.clientWidth - p.design.width * scale) / 2}px`;
      target.style.top = `${(iframe.clientHeight - p.design.height * scale) / 2}px`;
      target.style.transform = `scale(${scale})`;
    };
    new ResizeObserver(fit).observe(iframe);
    fit();
    $("scrub").max = timeline.total;
    buildChapters();
    const narration = await (await fetch("/api/narration")).json();
    const mixed = `out/${p.id}-audio.wav`;
    const mixedExists = await fetch("/" + mixed, { method: "HEAD" });
    const audioFile = mixedExists.ok
      ? mixed
      : narration?.file || p.audio?.file || mixed;
    const available = await fetch("/" + audioFile, { method: "HEAD" });
    if (available.ok) audio.src = "/" + audioFile;
    setStatus(
      audio.src
        ? "Ready"
        : "Ready with silent playback; run the audio command to prepare a score.",
    );
    audio.playbackRate = rate;
    audio.preservesPitch = true;
    applyCaptions();
    for (const id of ["play", "prev", "next", "back", "fwd"])
      $(id).disabled = false;
    await seek(
      clamp(
        Number(new URLSearchParams(location.search).get("t")) || 0,
        0,
        timeline.total,
      ),
    );
    setVeil("");
  } catch (e) {
    setStatus(e.message, true);
    setVeil(e.message, true);
  }
};
// Chapters: scenes that carry a chapter number are grouped under it, and the first scene of
// each chapter is a chapter mark; otherwise every scene is a mark.
function buildChapters() {
  const scenes = timeline.scenes,
    select = $("chapter");
  select.replaceChildren();
  const grouped = scenes.some((s) => s.ch);
  let group, lastCh;
  marks = [];
  for (const s of scenes) {
    const title = s.title || s.id.replace(/_/g, " ");
    if (grouped && s.ch !== lastCh) {
      lastCh = s.ch;
      group = document.createElement("optgroup");
      group.label = s.ch ? `Chapter ${s.ch}` : "Prologue";
      select.append(group);
      marks.push({ t: s.start, title: group.label });
    } else if (!grouped) marks.push({ t: s.start, title });
    const text = grouped && /^Chapter \d+$/.test(title) ? "Title card" : title;
    (grouped ? group : select).append(new Option(text, s.start));
  }
  $("ticks").replaceChildren(
    ...marks
      .filter((m) => m.t > 0 && marks.length <= 60)
      .map((m) => {
        const tick = document.createElement("i");
        tick.style.left = `${(m.t / timeline.total) * 100}%`;
        return tick;
      }),
  );
}
const sceneAt = (t) => timeline.scenes.findLast((s) => t >= s.start);
function jumpChapter(direction) {
  const starts = marks.map((m) => m.t);
  const target =
    direction > 0
      ? starts.find((t) => t > time + 0.25)
      : starts.findLast((t) => t < time - 1.5);
  seek(target ?? (direction > 0 ? timeline.total : 0));
}
async function seek(t) {
  if (!timeline) return;
  time = clamp(t, 0, timeline.total);
  if (audio.src) audio.currentTime = time;
  lastFrame = -1;
  await draw(time);
}
async function draw(t) {
  await iframe.contentWindow.__viewerSeek(t);
  const fraction = t / timeline.total;
  $("scrub").value = t;
  $("fill").style.width = `${fraction * 100}%`;
  $("thumb").style.left = `${fraction * 100}%`;
  $("time").innerHTML = `<b>${fmt(t)}</b> / ${fmt(timeline.total)}`;
  const scene = sceneAt(t),
    cue =
      scene?.caps?.findLast((c) => t - scene.start >= c[0]) ||
      scene?.lines?.findLast((c) => t - scene.start >= c.t);
  $("caption").textContent =
    caps && !captionsInFilm
      ? Array.isArray(cue)
        ? cue[1]
        : cue?.text || ""
      : "";
  if (scene) {
    $("chapter").value = String(scene.start);
  }
}
async function tick(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (playing && timeline) {
    time = audio.src
      ? audio.currentTime
      : Math.min(timeline.total, time + dt * rate);
    const f = Math.floor(time * Number($("fps").value));
    if (!busy && f !== lastFrame) {
      busy = true;
      lastFrame = f;
      try {
        await draw(Math.min(time, timeline.total - 0.00001));
      } catch (e) {
        setPlaying(false);
        setStatus(e.message, true);
      } finally {
        busy = false;
      }
    }
    if (time >= timeline.total) setPlaying(false);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function setPlaying(on) {
  playing = on;
  last = performance.now();
  $("play").innerHTML = on ? ICON.pause : ICON.play;
  $("play").setAttribute("aria-label", on ? "Pause" : "Play");
  $("play").title = on ? "Pause (Space)" : "Play (Space)";
  if (audio.src) {
    if (on)
      audio
        .play()
        .catch((e) =>
          setStatus(`Playback could not start: ${e.message}`, true),
        );
    else audio.pause();
  }
  wake();
}
function flash(icon) {
  const el = $("flash");
  el.innerHTML = icon;
  el.classList.remove("on");
  void el.offsetWidth;
  el.classList.add("on");
}
async function togglePlay() {
  if (!timeline) return;
  if (!playing && time >= timeline.total - 0.05) await seek(0);
  setPlaying(!playing);
  flash(playing ? ICON.play : ICON.pause);
}
$("play").onclick = togglePlay;
$("back").onclick = () => seek(time - 10);
$("fwd").onclick = () => seek(time + 10);
$("prev").onclick = () => jumpChapter(-1);
$("next").onclick = () => jumpChapter(1);
$("scrub").oninput = (e) => seek(Number(e.target.value));
$("scrub").onchange = () => $("scrub").blur();
$("chapter").onchange = (e) => {
  seek(Number(e.target.value));
  e.target.blur();
};
$("speed").onchange = (e) => {
  rate = Number(e.target.value);
  audio.playbackRate = rate;
  store.set("speed", e.target.value);
  e.target.blur();
};
$("fps").onchange = (e) => {
  store.set("fps", e.target.value);
  lastFrame = -1;
  e.target.blur();
};
$("volume").oninput = (e) => {
  audio.volume = Number(e.target.value);
  audio.muted = audio.volume === 0;
  store.set("volume", audio.volume);
  store.set("muted", audio.muted ? "1" : "0");
  syncMute();
};
function toggleMute() {
  audio.muted = !audio.muted;
  if (!audio.muted && audio.volume === 0) audio.volume = 0.5;
  store.set("muted", audio.muted ? "1" : "0");
  syncMute();
}
$("mute").onclick = toggleMute;
function toggleCaptions() {
  caps = !caps;
  store.set("captions", caps ? "1" : "0");
  $("captions").setAttribute("aria-pressed", String(caps));
  applyCaptions();
  if (timeline) draw(time);
}
$("captions").onclick = toggleCaptions;
const toggleFullscreen = () =>
  document.fullscreenElement
    ? document.exitFullscreen()
    : app.requestFullscreen();
$("fullscreen").onclick = toggleFullscreen;
document.onfullscreenchange = () => {
  $("fullscreen").innerHTML = document.fullscreenElement
    ? ICON.exit
    : ICON.full;
  $("fullscreen").setAttribute(
    "aria-label",
    document.fullscreenElement ? "Exit fullscreen" : "Fullscreen",
  );
  wake();
};
$("file").onchange = (e) => {
  if (!e.target.files[0]) return;
  setPlaying(false);
  iframe.hidden = true;
  hit.hidden = true;
  $("caption").hidden = true;
  const v = $("export");
  v.hidden = false;
  v.src = URL.createObjectURL(e.target.files[0]);
  setStatus(`Playing export: ${e.target.files[0].name}`);
};

// Click the film to play or pause, double-click for fullscreen. An overlay is needed because
// clicks inside the film's iframe never reach this page.
const hit = document.createElement("div");
hit.style.cssText = "position:absolute;inset:0;z-index:1";
$("viewport").append(hit);
let clickTimer;
hit.onclick = () => {
  clearTimeout(clickTimer);
  clickTimer = setTimeout(togglePlay, 220);
};
hit.ondblclick = () => {
  clearTimeout(clickTimer);
  toggleFullscreen();
};

// The track shows the time and scene under the pointer.
const track = $("track");
track.onpointermove = (e) => {
  if (!timeline) return;
  const box = track.getBoundingClientRect(),
    x = clamp(e.clientX - box.left, 0, box.width),
    t = (x / box.width) * timeline.total,
    scene = sceneAt(t);
  const tip = $("tip");
  tip.innerHTML = `${fmt(t)}${scene ? `<small>${(scene.title || scene.id.replace(/_/g, " ")).replace(/</g, "&lt;")}</small>` : ""}`;
  tip.style.left = `${clamp(x, tip.offsetWidth / 2, box.width - tip.offsetWidth / 2)}px`;
  tip.classList.add("on");
};
track.onpointerleave = () => $("tip").classList.remove("on");

// While playing in fullscreen the controls fade out until the pointer moves.
let idle;
function wake() {
  app.classList.remove("idle");
  clearTimeout(idle);
  if (playing && document.fullscreenElement)
    idle = setTimeout(() => app.classList.add("idle"), 2500);
}
app.addEventListener("pointermove", wake);
app.addEventListener("pointerdown", wake);

$("help").onclick = () => ($("help").hidden = true);
document.onkeydown = (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const tag = e.target.tagName;
  if (tag === "SELECT" || e.target.id === "volume") return;
  wake();
  const frame = 1 / Number($("fps").value);
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.code;
  const handled = {
    " ": togglePlay,
    k: togglePlay,
    ArrowRight: () => seek(time + (e.shiftKey ? 5 : frame)),
    ArrowLeft: () => seek(time - (e.shiftKey ? 5 : frame)),
    l: () => seek(time + 10),
    j: () => seek(time - 10),
    PageDown: () => jumpChapter(1),
    PageUp: () => jumpChapter(-1),
    Home: () => seek(0),
    End: () => timeline && seek(timeline.total),
    c: toggleCaptions,
    m: toggleMute,
    f: toggleFullscreen,
    "?": () => $("help").toggleAttribute("hidden"),
    Escape: () => ($("help").hidden = true),
  }[key];
  if (handled) {
    e.preventDefault();
    handled();
  } else if (/^[0-9]$/.test(key) && timeline) {
    e.preventDefault();
    seek((Number(key) / 10) * timeline.total);
  }
};
