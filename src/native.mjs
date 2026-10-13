import { spawn } from "node:child_process";
import { bundle } from "./build.mjs";
import { nativeBinary } from "./media.mjs";
import { nativeCapabilities } from "./capabilities.mjs";
import { aborter } from "./process.mjs";
export async function openNative(p, settings = {}) {
  const caps = await nativeCapabilities();
  if (!caps.available) throw Error(caps.reason);
  if (p.renderer === "browser-only" || p.adapter !== "scenegraph")
    throw Error(
      "Native execution requires scenegraph films classified portable or native-only",
    );
  const bundled = await bundle(p, { native: true });
  const child = spawn(
    nativeBinary(),
    ["native-server", bundled, p.manifestFile],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let error,
    waiter,
    stderr = "";
  // Chunk queue: concatenating on every stdout event recopies the whole
  // pending packet each time, so consume from the queue instead.
  let chunks = [],
    buffered = 0,
    headOff = 0;
  const onAbort = () => child.kill("SIGTERM");
  aborter.signal.addEventListener("abort", onAbort, { once: true });
  child.stderr.on(
    "data",
    (b) => (stderr = (stderr + b.toString()).slice(-10000)),
  );
  child.on("error", (e) => {
    error = e;
    waiter?.();
  });
  child.stdin.on("error", (e) => {
    error = e;
    waiter?.();
  });
  child.on("close", (code, signal) => {
    error = Error(`Native renderer exited ${signal || code}: ${stderr}`);
    waiter?.();
  });
  child.stdout.on("data", (b) => {
    chunks.push(b);
    buffered += b.length;
    waiter?.();
  });
  function take(n) {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const head = chunks[0],
        avail = head.length - headOff,
        count = Math.min(n - off, avail);
      head.copy(out, off, headOff, headOff + count);
      off += count;
      buffered -= count;
      if (count === avail) {
        chunks.shift();
        headOff = 0;
      } else {
        headOff += count;
      }
    }
    return out;
  }
  function peekU32() {
    const out = Buffer.allocUnsafe(4);
    let off = 0;
    for (let i = 0; i < chunks.length && off < 4; i++) {
      const start = i === 0 ? headOff : 0,
        count = Math.min(4 - off, chunks[i].length - start);
      chunks[i].copy(out, off, start, start + count);
      off += count;
    }
    return out.readUInt32LE(0);
  }
  async function packet() {
    const deadline = Date.now() + 120000;
    while (true) {
      if (buffered >= 4) {
        const len = peekU32();
        if (len > 256 * 1024 * 1024) throw Error("Invalid native frame length");
        if (buffered >= len + 4) {
          take(4);
          return take(len);
        }
      }
      if (error) throw error;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            child.kill("SIGKILL");
            reject(Error("Native renderer stalled"));
          },
          Math.max(1, deadline - Date.now()),
        );
        waiter = () => {
          clearTimeout(timer);
          waiter = null;
          resolve();
        };
      });
    }
  }
  try {
    const header = JSON.parse(await packet());
    for (const scene of header.timeline.scenes) {
      if (scene.renderer === "browser-only")
        throw Error(`Scene ${scene.id} is browser-only`);
      for (const required of scene.requires || [])
        if (!caps.features.includes(required))
          throw Error(`Scene ${scene.id}: native lacks ${required}`);
    }
    const capture = async (time, frame = 0) => {
      aborter.signal.throwIfAborted();
      const start = performance.now();
      child.stdin.write(
        JSON.stringify({
          time,
          width: settings.size?.[0] || p.design.width,
          height: settings.size?.[1] || p.design.height,
          fit: settings.fit || "fit",
          ss: settings.ss || 1,
          mb: settings.mb || 1,
          shutter: settings.shutter ?? 0.5,
          fps: settings.fps || 30,
        }) + "\n",
      );
      const png = await packet();
      return {
        png,
        drawMs: performance.now() - start,
        seekMs: 0,
        captureMs: 0,
      };
    };
    return {
      timeline: header.timeline,
      caps: {
        ...header.capabilities,
        renderer: header.capabilities.adapter,
        native: true,
      },
      browser: { version: async () => `QuickJS 0.14.0 / wgpu 22.1.0` },
      capture,
      seek: async (t) => capture(t),
      close: async () => {
        aborter.signal.removeEventListener("abort", onAbort);
        child.stdin.end();
        await new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 3000);
          child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
    };
  } catch (e) {
    child.kill("SIGTERM");
    aborter.signal.removeEventListener("abort", onAbort);
    throw e;
  }
}
