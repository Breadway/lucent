import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import * as fontkit from "fontkit";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inside, bundlePath } from "./project.mjs";
import { narrationTiming } from "./narration.mjs";
export const ENGINE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".flac": "audio/flac",
  ".srt": "text/plain",
};
export function createServer(p) {
  const token = randomBytes(24).toString("hex");
  const fonts = new Map();
  const server = http.createServer((req, res) => {
    try {
      if (req.url === "/api/font-check" && req.method === "POST") {
        let text = "";
        req.on("data", (b) => {
          text += b.toString();
          if (text.length > 65536) req.destroy();
        });
        req.on("end", () => {
          try {
            const n = JSON.parse(text),
              families = [n.font, ...(n.fallback || [])],
              faces = families.map((family) => {
                const f = p.fonts?.find(
                  (f) =>
                    f.family === family &&
                    Number(f.weight || 400) === Number(n.weight || 400) &&
                    (f.style || "normal") === (n.style || "normal"),
                );
                if (!f)
                  throw Error(
                    `Undeclared font face ${family}/${n.weight}/${n.style}`,
                  );
                const file = inside(p.root, f.file);
                if (!fonts.has(file)) fonts.set(file, fontkit.openSync(file));
                return fonts.get(file);
              });
            for (const char of n.text) {
              if (char === "\n" || char === "\t") continue;
              if (
                !faces.some((f) => f.hasGlyphForCodePoint(char.codePointAt(0)))
              )
                throw Error(
                  `Missing font glyph U+${char.codePointAt(0).toString(16)}`,
                );
            }
            res.end("ok");
          } catch (e) {
            res.writeHead(400);
            res.end(e.message);
          }
        });
        return;
      }
      if (req.url === "/api/frame" && req.method === "POST") {
        if (req.headers["x-film-token"] !== token) {
          res.writeHead(403);
          return res.end();
        }
        let bytes = 0;
        const chunks = [];
        req.on("data", (b) => {
          bytes += b.length;
          if (bytes > 256 * 1024 * 1024) {
            req.destroy();
            return;
          }
          chunks.push(b);
        });
        req.on("end", () => {
          server.frame = Buffer.concat(chunks);
          res.end("ok");
        });
        return;
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405);
        return res.end();
      }
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/narration") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(narrationTiming(p) || null));
      }
      if (url.pathname === "/api/project") {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({ ...p, root: undefined, manifestFile: undefined }),
        );
      }
      let file = decodeURIComponent(url.pathname),
        root = p.root;
      if (file === "/__film.js") {
        const bundle = bundlePath(p);
        res.setHeader("content-type", "text/javascript");
        return fs.createReadStream(bundle).pipe(res);
      }
      if (file === "/") file = "/engine/web/viewer.html";
      if (file.startsWith("/engine/") && !p.reference) {
        root = ENGINE;
        file = file.slice(8);
        if (!["compat/", "sdk/", "web/"].some((v) => file.startsWith(v)))
          throw Error("private engine path");
      } else file = file.slice(1);
      if (
        file.split("/").some((v) => v.startsWith(".")) ||
        !types[path.extname(file)] ||
        (/tts|requests|manifest|film\.json/.test(file) &&
          file !== "out/tts/narration.wav")
      )
        throw Error("not served");
      const actual = inside(root, file),
        s = fs.statSync(actual);
      if (!s.isFile()) throw Error("not file");
      let first = 0,
        last = s.size - 1,
        status = 200;
      if (req.headers.range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!m || (!m[1] && !m[2])) {
          res.writeHead(416, { "content-range": `bytes */${s.size}` });
          return res.end();
        }
        first = m[1] ? Number(m[1]) : Math.max(0, s.size - Number(m[2]));
        last = m[1] && m[2] ? Number(m[2]) : last;
        if (first > last || first >= s.size) {
          res.writeHead(416, { "content-range": `bytes */${s.size}` });
          return res.end();
        }
        last = Math.min(last, s.size - 1);
        status = 206;
        res.setHeader("content-range", `bytes ${first}-${last}/${s.size}`);
      }
      res.writeHead(status, {
        "content-type": types[path.extname(file)],
        "content-length": Math.max(0, last - first + 1),
        "accept-ranges": "bytes",
        "cache-control": "no-cache",
      });
      if (req.method === "HEAD" || !s.size) return res.end();
      const stream = fs.createReadStream(actual, { start: first, end: last });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.frameToken = token;
  return server;
}
export async function serve(p, port = 0) {
  const server = createServer(p);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  };
}
