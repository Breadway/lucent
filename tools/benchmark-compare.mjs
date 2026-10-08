import fs from "node:fs";
const [baselineFile, candidateFile] = process.argv.slice(2),
  a = JSON.parse(fs.readFileSync(baselineFile)),
  b = JSON.parse(fs.readFileSync(candidateFile));
for (const field of ["project", "resolution", "frameCount", "fps", "range"])
  if (JSON.stringify(a[field]) !== JSON.stringify(b[field]))
    throw Error(`Benchmarks differ in ${field}`);
if (
  JSON.stringify(a.settings.codecs) !== JSON.stringify(b.settings.codecs) ||
  a.settings.bitrate !== b.settings.bitrate ||
  a.settings.quality !== b.settings.quality
)
  throw Error("Codec/quality settings differ");
if (a.metrics.framesReused || b.metrics.framesReused)
  throw Error("Promotion requires uncached complete exports");
const improvement = b.exportFps / a.exportFps - 1;
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      endToEndThroughputImprovement: improvement,
      meetsPerformanceThreshold: improvement >= 0.2,
      eligibleForPromotion: false,
      reason:
        "Performance alone is insufficient; repeat representative exports and attach feature/colour/conformance verification before promotion.",
    },
    null,
    2,
  ),
);
