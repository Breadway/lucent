import { frameGraph, sourceTime } from "/engine/sdk/index.js";
import { LinearCompositor } from "./linear.js";
import { gradientStyle } from "./gradient.js";
export class GraphRenderer {
  constructor(canvas, film, manifest) {
    this.canvas = canvas;
    this.film = film;
    this.manifest = manifest;
    this.images = new Map();
    this.clips = new Map();
    this.checkedText = new Set();
  }
  async prepare(t, fps = 30) {
    const graph = frameGraph(this.film, t, fps);
    if (this.film.grain?.opacity === 0) delete graph.grain;
    await this.prepareNode(graph, t);
    return graph;
  }
  async prepareNode(n, t) {
    t = n.time ?? t;
    if (
      n.type === "text" &&
      !this.checkedText.has(
        JSON.stringify([n.text, n.font, n.fallback, n.weight, n.style]),
      )
    ) {
      const response = await fetch("/api/font-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: n.text,
          font: n.font || "Inter",
          fallback: n.fallback || [],
          weight: n.weight || 400,
          style: n.style || "normal",
        }),
      });
      if (!response.ok) throw Error(await response.text());
      this.checkedText.add(
        JSON.stringify([n.text, n.font, n.fallback, n.weight, n.style]),
      );
    }
    for (const child of n.children || []) await this.prepareNode(child, t);
    if (n.type === "image" && !this.images.has(n.src)) {
      const im = new Image();
      im.src = "/" + n.src;
      await im.decode();
      this.images.set(n.src, im);
    }
    if (n.type === "video") {
      let v = this.clips.get(n.src);
      if (!v) {
        v = document.createElement("video");
        v.src = "/" + n.src;
        v.muted = true;
        v.preload = "auto";
        await new Promise((r, j) => {
          v.onloadedmetadata = r;
          v.onerror = () => j(Error("Video load failed"));
        });
        this.clips.set(n.src, v);
      }
      const target = Math.min(v.duration - 0.00001, sourceTime(t, n));
      if (Math.abs(v.currentTime - target) > 0.00001)
        await new Promise((r, j) => {
          v.onseeked = r;
          v.onerror = j;
          v.currentTime = target;
        });
    }
  }
  draw(graph) {
    if (graph.grain?.opacity === 0) delete graph.grain;
    const c = this.canvas.getContext("2d", { colorSpace: "srgb" });
    if (
      !this.compositor ||
      this.compositor.width !== this.canvas.width ||
      this.compositor.height !== this.canvas.height
    ) {
      this.compositor = new LinearCompositor(
        this.canvas.width,
        this.canvas.height,
      );
      this.layer = document.createElement("canvas");
      this.layer.width = this.canvas.width;
      this.layer.height = this.canvas.height;
    }
    const bg = document.createElement("canvas").getContext("2d");
    bg.fillStyle = graph.background || "#000";
    bg.fillRect(0, 0, 1, 1);
    this.compositor.begin([...bg.getImageData(0, 0, 1, 1).data].slice(0, 3));
    const lc = this.layer.getContext("2d", { colorSpace: "srgb" });
    const blendLeafTypes = new Set(["rect", "circle", "path", "text", "image", "video"]);
    const leafTypes = new Set([
      "rect",
      "circle",
      "path",
      "text",
      "image",
      "video",
      "shader",
    ]);
    const visit = (n, parents) => {
      if (n.effect) throw Error(`Unsupported portable effect: ${n.effect}`);
      if (n.blend != null && !blendLeafTypes.has(n.type))
        throw Error(`blend applies to rect, circle, path, text, image and video leaves only; a ${n.type} node cannot set it`);
      if (leafTypes.has(n.type)) {
        lc.resetTransform();
        lc.clearRect(0, 0, this.layer.width, this.layer.height);
        const dw = this.manifest.design.width,
          dh = this.manifest.design.height,
          fit = this.manifest.fit || "fit";
        const scale =
          fit === "fill"
            ? Math.max(this.layer.width / dw, this.layer.height / dh)
            : Math.min(this.layer.width / dw, this.layer.height / dh);
        if (fit === "stretch")
          lc.scale(this.layer.width / dw, this.layer.height / dh);
        else {
          lc.translate(
            (this.layer.width - dw * scale) / 2,
            (this.layer.height - dh * scale) / 2,
          );
          lc.scale(scale, scale);
        }
        let tree = { ...n, children: [] };
        for (const parent of [...parents].reverse())
          tree = { ...parent, children: [tree] };
        this.node(lc, tree);
        this.compositor.add(this.layer, n.blend ?? "normal");
      }
      for (const child of n.children || [])
        visit(child, [...parents, { ...n, type: "group" }]);
    };
    visit(graph, []);
    if (graph.grain) this.compositor.grain(graph.grain);
    c.resetTransform();
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.compositor.finish(c);
  }
  node(c, n) {
    c.save();
    c.globalAlpha *= n.opacity ?? 1;
    c.translate(n.translate?.[0] || 0, n.translate?.[1] || 0);
    c.rotate(n.rotate || 0);
    c.scale(n.scale?.[0] ?? 1, n.scale?.[1] ?? 1);
    if (n.clip) {
      c.beginPath();
      c.rect(...n.clip);
      c.clip();
    }
    if (n.effect) throw Error(`Unsupported portable effect: ${n.effect}`);
    const stroked = n.type === "path" && n.stroke;
    const fill =
      !stroked && ["rect", "circle", "path"].includes(n.type)
        ? n.fill
        : undefined;
    if (fill == null || typeof fill === "string") {
      c.fillStyle = fill || n.color || "#fff";
    } else if (fill && typeof fill === "object") {
      c.fillStyle = gradientStyle(c, fill);
    } else {
      throw Error("fill must be a colour string or a gradient descriptor");
    }
    switch (n.type) {
      case "rect":
        c.fillRect(n.x, n.y, n.width, n.height);
        break;
      case "circle":
        c.beginPath();
        c.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
        c.fill();
        break;
      case "path":
        c.beginPath();
        for (const [op, ...a] of n.commands) {
          const method = {
            M: "moveTo",
            L: "lineTo",
            C: "bezierCurveTo",
            Q: "quadraticCurveTo",
            Z: "closePath",
          }[op];
          if (!method) throw Error(`Invalid path command ${op}`);
          c[method](...a);
        }
        n.stroke
          ? ((c.strokeStyle = n.color),
            (c.lineWidth = n.strokeWidth || 1),
            c.stroke())
          : c.fill();
        break;
      case "text": {
        const family = n.font || "Inter";
        if (!this.manifest.fonts?.some((f) => f.family === family))
          throw Error(`Undeclared font ${family}`);
        c.font = `${n.style || "normal"} ${n.weight || 400} ${n.size || 32}px "${family}"${(n.fallback || []).map((f) => `,"${f}"`).join("")}`;
        c.textAlign = n.align || "left";
        c.textBaseline = "alphabetic";
        c.fontKerning = n.kerning === false ? "none" : "normal";
        c.direction = n.direction || "ltr";
        const lines = [];
        for (const line of n.text.split("\n")) {
          if (!n.wrapWidth) {
            lines.push(line);
            continue;
          }
          let row = "";
          const parts =
            typeof Intl.Segmenter === "function"
              ? [
                  ...new Intl.Segmenter(n.language || "en", {
                    granularity: "word",
                  }).segment(line),
                ].map((x) => x.segment)
              : line.split(/(?<=\s)/u);
          for (const part of parts) {
            const next = row + part;
            if (row.trim() && c.measureText(next).width > n.wrapWidth) {
              lines.push(row.trimEnd());
              row = part.trimStart();
            } else row = next;
            if (c.measureText(row).width > n.wrapWidth && row.length > 1) {
              let rest = "";
              for (const char of row) {
                if (c.measureText(rest + char).width > n.wrapWidth && rest) {
                  lines.push(rest);
                  rest = char;
                } else rest += char;
              }
              row = rest;
            }
          }
          lines.push(row.trimEnd());
        }
        lines.forEach((line, i) =>
          c.fillText(line, n.x, n.y + i * (n.lineHeight || n.size * 1.2)),
        );
        break;
      }
      case "image":
        c.drawImage(this.images.get(n.src), n.x, n.y, n.width, n.height);
        break;
      case "video":
        c.drawImage(this.clips.get(n.src), n.x, n.y, n.width, n.height);
        break;
      case "shader":
        throw Error("Shader requires a backend-specific renderer capability");
    }
    for (const child of n.children || []) this.node(c, child);
    c.restore();
  }
}
export async function loadFonts(manifest) {
  for (const f of manifest.fonts || []) {
    const face = new FontFace(f.family, `url(/${f.file})`, {
      weight: String(f.weight || 400),
      style: f.style || "normal",
    });
    await face.load();
    document.fonts.add(face);
  }
  await document.fonts.ready;
}
