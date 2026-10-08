import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const children = new Set();
export const aborter = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    aborter.abort(Error("Job cancelled"));
    for (const c of children) c.kill("SIGTERM");
  });
export function subprocess(
  cmd,
  args,
  { input, timeout = 120000, cwd, pipe = false, stdoutSink } = {},
) {
  const c = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  children.add(c);
  let stderr = "",
    stdout = [];
  const done = new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      c.kill("SIGKILL");
      reject(Error(`${cmd} timed out`));
    }, timeout);
    c.once("error", (e) => {
      clearTimeout(timer);
      children.delete(c);
      reject(e);
    });
    c.stderr.on("data", (b) => {
      stderr = (stderr + b.toString()).slice(-20000);
    });
    if (stdoutSink) c.stdout.pipe(stdoutSink);
    else c.stdout.on("data", (b) => stdout.push(b));
    c.stdin.on("error", () => {});
    c.once("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(c);
      code === 0
        ? resolve(Buffer.concat(stdout))
        : reject(Error(`${cmd} exited ${signal || code}: ${stderr}`));
    });
  });
  done.catch(() => {});
  if (!pipe) c.stdin.end(input);
  return {
    child: c,
    done,
    write: (buf) =>
      new Promise((resolve, reject) => {
        if (c.exitCode !== null || aborter.signal.aborted)
          return reject(Error("Process exited or job cancelled"));
        c.stdin.write(buf, (e) => (e ? reject(e) : resolve()));
        done.then(() => reject(Error("Process exited before write")), reject);
      }),
    stderr: () => stderr,
  };
}
export const run = async (cmd, args, options) =>
  subprocess(cmd, args, options).done;
export function lease(root, resource, limit = 2) {
  fs.mkdirSync(root, { recursive: true });
  for (let slot = 0; slot < limit; slot++) {
    const f = path.join(root, `${resource}-${slot}.lock`);
    try {
      fs.writeFileSync(
        f,
        JSON.stringify({ pid: process.pid, created: Date.now() }),
        { flag: "wx" },
      );
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(f)).pid === process.pid)
            fs.unlinkSync(f);
        } catch {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const owner = JSON.parse(fs.readFileSync(f));
        try {
          process.kill(owner.pid, 0);
        } catch (check) {
          if (check.code === "ESRCH") {
            fs.unlinkSync(f);
            slot--;
          }
        }
      } catch {}
    }
  }
  throw Error(`All ${limit} ${resource} slots are in use by other jobs`);
}
