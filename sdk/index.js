export const API_VERSION = "0.1.0";
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const ease = {
  linear: (t) => t,
  inOut: (t) => t * t * (3 - 2 * t),
  out: (t) => 1 - (1 - t) ** 3,
};
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function defineFilm(film) {
  if (film.apiVersion && film.apiVersion !== API_VERSION)
    throw Error(
      `Incompatible film SDK API ${film.apiVersion}; expected ${API_VERSION}`,
    );
  if (!film.scenes?.length) throw Error("Film needs scenes");
  let cursor = 0;
  const ids = new Set();
  const scenes = film.scenes.map((s) => {
    if (
      !s.id ||
      ids.has(s.id) ||
      !(Number.isFinite(s.duration) && s.duration > 0) ||
      !Number.isFinite(s.start ?? cursor) ||
      (s.start ?? cursor) < 0 ||
      typeof s.frame !== "function"
    )
      throw Error("Scenes need unique IDs and positive durations");
    if (
      s.renderer &&
      !["browser-only", "portable", "native-only"].includes(s.renderer)
    )
      throw Error(`Invalid renderer classification for scene ${s.id}`);
    if (
      (s.requires || []).some(
        (feature) => typeof feature !== "string" || !feature,
      )
    )
      throw Error(`Scene ${s.id} has an invalid capability declaration`);
    if (
      !(s.dependencies || []).every(
        (dependency) =>
          typeof dependency === "string" ||
          typeof dependency?.path === "string",
      )
    )
      throw Error(`Scene ${s.id} has an invalid dependency declaration`);
    ids.add(s.id);
    const start = s.start ?? cursor;
    cursor = Math.max(cursor, start + s.duration);
    return { renderer: "portable", dependencies: [], ...s, start };
  });
  return { apiVersion: API_VERSION, ...film, scenes, duration: cursor };
}
export function frameGraph(film, t) {
  return {
    background: film.background || "#000000",
    children: film.scenes
      .filter((s) => t >= s.start && t < s.start + s.duration)
      .map((s) => ({
        type: "group",
        time: t - s.start,
        children: [
          s.frame(t - s.start, {
            time: t,
            scene: s,
            random: rng((film.seed || 0) + Math.round(t * 1e6)),
          }),
        ].flat(),
      })),
  };
}
export const group = (children, props = {}) => ({
  type: "group",
  children,
  ...props,
});
export const rect = (x, y, width, height, color, props = {}) => ({
  type: "rect",
  x,
  y,
  width,
  height,
  color,
  ...props,
});
export const circle = (x, y, radius, color, props = {}) => ({
  type: "circle",
  x,
  y,
  radius,
  color,
  ...props,
});
export const text = (value, x, y, props = {}) => ({
  type: "text",
  text: value,
  x,
  y,
  font: "Inter",
  size: 32,
  color: "#ffffff",
  ...props,
});
export const image = (src, x, y, width, height, props = {}) => ({
  type: "image",
  src,
  x,
  y,
  width,
  height,
  ...props,
});
export const path = (commands, props = {}) => ({
  type: "path",
  commands,
  color: "#ffffff",
  ...props,
});
export const video = (src, x, y, width, height, props = {}) => ({
  type: "video",
  src,
  x,
  y,
  width,
  height,
  trim: 0,
  rate: 1,
  ...props,
});
// A whole SVG document drawn as one leaf (design-space units). Needs the "svg" capability, and
// the fonts its text uses must be declared in the manifest. `grain` optionally overlays
// seeded film grain: { seed, opacity?, width?, height? }.
export const svg = (markup, props = {}) => ({ type: "svg", markup, ...props });
export const camera = (children, props = {}) =>
  group(children, { type: "camera", ...props });
export function sourceTime(t, { trim = 0, rate = 1, duration, loop = false }) {
  let local = Math.max(0, t) * rate;
  if (loop) {
    if (!(duration > 0)) throw Error("Loop requires duration");
    local = ((local % duration) + duration) % duration;
  }
  return trim + local;
}
export function extensionRegistry() {
  const providers = new Map();
  return {
    register(kind, name, provider) {
      if (provider.apiVersion !== API_VERSION)
        throw Error(`Incompatible ${kind} extension ${name}`);
      const id = `${kind}:${name}`;
      if (providers.has(id)) throw Error(`Duplicate extension ${id}`);
      providers.set(id, provider);
    },
    get(kind, name) {
      const p = providers.get(`${kind}:${name}`);
      if (!p) throw Error(`Unknown ${kind} extension ${name}`);
      return p;
    },
    capabilities() {
      return [...providers].map(([id, p]) => ({
        id,
        apiVersion: p.apiVersion,
        capabilities: p.capabilities || [],
      }));
    },
  };
}

// Extended narration holds the last authored state; its timestamps remain unscaled.
export function applyNarration(film, timing) {
  if (!timing) return film;
  const scenes = film.scenes.map((scene) => {
    const change = timing.overrides.find((s) => s.id === scene.id);
    if (!change) throw Error(`Narration timeline missing scene ${scene.id}`);
    const authored = scene.frame;
    return {
      ...scene,
      start: change.start,
      duration: change.duration,
      caps: change.caps,
      frame: (t, ctx) =>
        authored(Math.min(t, change.originalDuration - 1e-6), ctx),
    };
  });
  return { ...film, scenes, duration: timing.total };
}
