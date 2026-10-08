import fs from "node:fs";
export function memoryMonitor() {
  let peak = 0,
    childrenPeak = 0;
  function read(pid, seen = new Set()) {
    if (seen.has(pid)) return 0;
    seen.add(pid);
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8"),
        rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0) * 1024;
      let total = rss;
      for (const task of fs.readdirSync(`/proc/${pid}/task`)) {
        let childText = "";
        try {
          childText = fs.readFileSync(
            `/proc/${pid}/task/${task}/children`,
            "utf8",
          );
        } catch {}
        for (const child of childText.trim().split(/\s+/).filter(Boolean))
          total += read(Number(child), seen);
      }
      return total;
    } catch {
      return 0;
    }
  }
  function sample() {
    const total = read(process.pid),
      self = process.memoryUsage().rss;
    peak = Math.max(peak, total);
    childrenPeak = Math.max(childrenPeak, total - self);
  }
  sample();
  const timer = setInterval(sample, 100);
  return () => {
    clearInterval(timer);
    sample();
    return {
      processTreePeakRssBytes: peak,
      childPeakRssBytes: Math.max(0, childrenPeak),
      enginePeakRssBytes: process.resourceUsage().maxRSS * 1024,
      samplingIntervalMs: 100,
    };
  };
}
