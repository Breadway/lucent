import puppeteer from "puppeteer-core";
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { serve } from "./server.mjs";
import { bundle } from "./build.mjs";
import { aborter } from "./process.mjs";
export function browserPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), ".cache/ms-playwright");
  if (fs.existsSync(cache))
    for (const n of fs
      .readdirSync(cache)
      .filter((n) => n.startsWith("chromium_headless_shell-"))
      .sort()
      .reverse()) {
      const p = path.join(
        cache,
        n,
        "chrome-headless-shell-linux64/chrome-headless-shell",
      );
      if (fs.existsSync(p)) return p;
    }
  for (const p of ["/usr/bin/chromium", "/usr/bin/google-chrome"])
    if (fs.existsSync(p)) return p;
  throw Error("Install Chromium or set CHROMIUM_PATH");
}
export async function openFilm(p, options = {}) {
  if (p.adapter === "scenegraph") await bundle(p);
  const service = await serve(p);
  let browser;
  const onAbort = () => {
    if (browser) void browser.close();
  };
  aborter.signal.addEventListener("abort", onAbort, { once: true });
  try {
    browser = await puppeteer.launch({
      executablePath: browserPath(),
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--force-color-profile=srgb",
        "--font-render-hinting=none",
        "--disable-lcd-text",
        "--disable-font-subpixel-positioning",
        "--enable-accelerated-2d-canvas",
        ...(options.cpu
          ? ["--disable-gpu"]
          : ["--enable-gpu-rasterization", "--ignore-gpu-blocklist"]),
      ],
      protocolTimeout: 120000,
    });
    const page = await browser.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const [w, h] = options.size || [p.design.width, p.design.height];
    const browserMaxTexture = await page.evaluate(() => {
      const canvas = document.createElement("canvas"),
        gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      return gl?.getParameter(gl.MAX_TEXTURE_SIZE) || 16384;
    });
    if (
      w * (options.ss || 1) > browserMaxTexture ||
      h * (options.ss || 1) > browserMaxTexture
    )
      throw Error(
        `Requested render surface ${w * (options.ss || 1)}x${h * (options.ss || 1)} exceeds browser texture limit ${browserMaxTexture}`,
      );
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    const query = new URLSearchParams({
      ...p.query,
      ss: String(options.ss || 1),
      w: p.design.width,
      h: p.design.height,
    });
    if (p.adapter === "scenegraph") {
      await page.goto(service.url + "/engine/web/graph.html");
      await page.evaluate(
        async (p, options) => {
          const { GraphRenderer, loadFonts } = await import(
            "/engine/web/graph.js"
          );
          await loadFonts(p);
          const mod = await import("/__film.js");
          const film = mod.default;
          const canvas = document.getElementById("c");
          canvas.width =
            (options.size?.[0] || p.design.width) * (options.ss || 1);
          canvas.height =
            (options.size?.[1] || p.design.height) * (options.ss || 1);
          const renderer = new GraphRenderer(canvas, film, {
            ...p,
            fit: options.fit,
          });
          window.__engine = {
            timeline: {
              total: film.duration,
              scenes: film.scenes.map((s) => ({
                ...s,
                frame: undefined,
                implementation: String(s.frame),
                dur: s.duration,
              })),
            },
            canvas,
            seek: async (t, frame, mb = 1, shutter = 0.5, fps = 30) => {
              if (mb === 1) return renderer.draw(await renderer.prepare(t, fps));
              const c = canvas.getContext("2d"),
                sum = new Float32Array(canvas.width * canvas.height * 3);
              const linear = (v) =>
                v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
              const encoded = (v) =>
                v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
              for (let i = 0; i < mb; i++) {
                const sample = Math.max(
                  0,
                  Math.min(
                    film.duration - 1e-6,
                    t + ((i / (mb - 1) - 0.5) * shutter) / fps,
                  ),
                );
                renderer.draw(await renderer.prepare(sample, fps));
                const pixels = c.getImageData(
                  0,
                  0,
                  canvas.width,
                  canvas.height,
                ).data;
                for (let p = 0; p < pixels.length / 4; p++)
                  for (let channel = 0; channel < 3; channel++)
                    sum[p * 3 + channel] +=
                      linear(pixels[p * 4 + channel] / 255) / mb;
              }
              const pixels = new Uint8ClampedArray(
                canvas.width * canvas.height * 4,
              );
              for (let p = 0; p < pixels.length / 4; p++) {
                for (let channel = 0; channel < 3; channel++)
                  pixels[p * 4 + channel] = encoded(sum[p * 3 + channel]) * 255;
                pixels[p * 4 + 3] = 255;
              }
              c.putImageData(
                new ImageData(pixels, canvas.width, canvas.height),
                0,
                0,
              );
            },
          };
        },
        p,
        options,
      );
    } else {
      await page.goto(`${service.url}/${p.entry}?${query}`);
      await page.waitForFunction(
        p.adapter === "astra"
          ? "window.__ready===true"
          : p.adapter === "custom"
            ? "!!window.__engine"
            : "window.READY===true",
        { timeout: 60000 },
      );
      await page.evaluate((p) => {
        if (p.adapter === "custom") {
          return;
        }
        if (p.adapter === "astra") {
          window.__engine = {
            timeline: window.TL,
            seek: async (t, frame) => window.__seek(t, frame),
          };
        } else {
          window.__engine = {
            timeline: {
              total: FILMDATA.duration,
              scenes: FILMDATA.scenes.map((s) => ({
                ...s,
                caps: (s.lines || []).map((l) => [l.t, l.text]),
              })),
            },
            canvas: document.getElementById("c"),
            seek: async (t, frame, mb = 1, shutter = 0.5, fps = 30) => {
              const ts = mb > 1 ? mbTimes(t, mb, shutter, fps) : [t];
              if (window.prepFrame) await prepFrame(ts);
              mb > 1 ? renderFrameMB(t, mb, shutter, fps) : renderFrame(t);
            },
          };
        }
      }, p);
    }
    await page.evaluate(
      (p, w, h, fit) => {
        document.body.style.margin = "0";
        document.body.style.overflow = "hidden";
        if (p.adapter === "astra") {
          const stage = document.getElementById("stage");
          stage.style.transformOrigin = "0 0";
          const hud = document.getElementById("hud");
          if (hud) hud.style.transform = "translateZ(0)";
          const scale =
            fit === "fill"
              ? Math.max(w / p.design.width, h / p.design.height)
              : Math.min(w / p.design.width, h / p.design.height);
          const defs = [...document.querySelectorAll("svg")].filter(
            (n) => !stage.contains(n),
          );
          document.body.replaceChildren();
          for (const n of defs) document.body.append(n);
          const host = document.createElement("div");
          host.style.cssText = `position:absolute;inset:0;background:black;overflow:hidden`;
          stage.style.cssText += `;position:absolute;left:${(w - p.design.width * scale) / 2}px;top:${(h - p.design.height * scale) / 2}px;width:${p.design.width}px;height:${p.design.height}px;transform:scale(${fit === "stretch" ? w / p.design.width : scale},${fit === "stretch" ? h / p.design.height : scale})`;
          if (fit === "stretch") {
            stage.style.left = "0";
            stage.style.top = "0";
          }
          host.append(stage);
          document.body.append(host);
        } else {
          const source = window.__engine.canvas;
          source.style.display = "none";
          const out = document.createElement("canvas");
          out.width = w;
          out.height = h;
          out.id = "engine-output";
          document.body.append(out);
          window.__engine.output = out;
          window.__engine.fit = fit;
        }
      },
      p,
      w,
      h,
      options.fit || "fit",
    );
    const timeline = await page.evaluate(() => window.__engine.timeline);
    const caps = await page.evaluate(() => {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl");
      const gl2canvas = document.createElement("canvas");
      const gl2 = gl2canvas.getContext("webgl2");
      const extension = gl?.getExtension("WEBGL_debug_renderer_info");
      return {
        webgl: !!gl,
        webgl2: !!gl2,
        linearFloatTargets: !!gl2?.getExtension("EXT_color_buffer_float"),
        maxTextureDimension:
          gl2?.getParameter(gl2.MAX_TEXTURE_SIZE) ||
          gl?.getParameter(gl.MAX_TEXTURE_SIZE) ||
          16384,
        webgpu: !!navigator.gpu,
        renderer: extension
          ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
          : null,
        webcodecs: typeof VideoEncoder !== "undefined",
      };
    });
    async function seek(t, frame = 0) {
      aborter.signal.throwIfAborted();
      const t0 = performance.now();
      const actualDraw = await page.evaluate(
        async (t, frame, mb, sh, fps) => {
          const drawStart = performance.now();
          await window.__engine.seek(t, frame, mb, sh, fps);
          const e = window.__engine;
          if (e.output) {
            const c = e.output.getContext("2d");
            c.fillStyle = "#000";
            c.fillRect(0, 0, e.output.width, e.output.height);
            const s =
              e.fit === "fill"
                ? Math.max(
                    e.output.width / e.canvas.width,
                    e.output.height / e.canvas.height,
                  )
                : Math.min(
                    e.output.width / e.canvas.width,
                    e.output.height / e.canvas.height,
                  );
            if (e.fit === "stretch")
              c.drawImage(e.canvas, 0, 0, e.output.width, e.output.height);
            else
              c.drawImage(
                e.canvas,
                (e.output.width - e.canvas.width * s) / 2,
                (e.output.height - e.canvas.height * s) / 2,
                e.canvas.width * s,
                e.canvas.height * s,
              );
          }
          return performance.now() - drawStart;
        },
        t,
        frame,
        options.mb || 1,
        options.shutter ?? 0.5,
        options.fps || 30,
      );
      if (errors.length) throw Error(errors.join("\n"));
      return { drawMs: actualDraw, seekMs: performance.now() - t0 };
    }
    async function capture(t, frame = 0) {
      const { drawMs, seekMs } = await seek(t, frame);
      if (p.adapter === "astra" || p.adapter === "custom")
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
      const start = performance.now();
      if (options.capture === "rgba") {
        const timings = await page.evaluate(
          async (token, time) => {
            const canvas = window.__engine.output;
            if (!canvas)
              throw Error(
                "Raw capture requires a Canvas output; DOM capture is browser PNG only",
              );
            if (typeof VideoFrame === "undefined")
              throw Error("VideoFrame unavailable");
            const start = performance.now();
            const frame = new VideoFrame(canvas, {
              timestamp: Math.round(time * 1e6),
            });
            try {
              const bytes = new Uint8Array(canvas.width * canvas.height * 4);
              await frame.copyTo(bytes, {
                format: "RGBA",
                colorSpace: "srgb",
                layout: [{ offset: 0, stride: canvas.width * 4 }],
              });
              const copied = performance.now();
              const response = await fetch("/api/frame", {
                method: "POST",
                headers: { "x-film-token": token },
                body: bytes,
              });
              if (!response.ok) throw Error("Frame transfer failed");
              return {
                copyMs: copied - start,
                transferMs: performance.now() - copied,
              };
            } finally {
              frame.close();
            }
          },
          service.server.frameToken,
          t,
        );
        const raw = service.server.frame;
        if (!raw || raw.length !== w * h * 4)
          throw Error("Invalid raw frame layout");
        const png = PNG.sync.write(
          { width: w, height: h, data: raw },
          { deflateLevel: 1, filterType: 0 },
        );
        service.server.frame = null;
        return {
          png,
          drawMs,
          seekMs,
          captureMs: performance.now() - start,
          rawCopyMs: timings.copyMs,
          rawTransferMs: timings.transferMs,
        };
      }
      const png = await page.screenshot({
        type: "png",
        omitBackground: false,
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      });
      return {
        png: Buffer.from(png),
        drawMs,
        seekMs,
        captureMs: performance.now() - start,
      };
    }
    return {
      page,
      browser,
      timeline,
      caps,
      seek,
      capture,
      close: async () => {
        aborter.signal.removeEventListener("abort", onAbort);
        await browser.close();
        await service.close();
      },
    };
  } catch (e) {
    aborter.signal.removeEventListener("abort", onAbort);
    if (browser) await browser.close();
    await service.close();
    throw e;
  }
}
