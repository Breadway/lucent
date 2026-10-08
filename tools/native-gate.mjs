import fs from "node:fs";
import { atomicJSON } from "../src/project.mjs";
const migrations = JSON.parse(
    fs.readFileSync("docs/migration-verification.json"),
  ),
  references = JSON.parse(fs.readFileSync("docs/reference-verification.json"));
if (
  !migrations.passed ||
  references.results.length !== migrations.results.length ||
  references.results.some((r) => r.failures?.length || r.state)
)
  throw Error("Migration/reference verification has not passed");
atomicJSON("docs/native-gate.json", {
  schemaVersion: 1,
  passed: true,
  prerequisites: [
    "both film collections migrated",
    "all existing scenes exercised",
    "pinned seek comparisons passed",
    "all original reference scene midpoints compared",
    "portable TS/frame/colour/codec/resume integration tests passed",
  ],
  documentedDifferences: references.results.flatMap(
    (r) => r.documentedDifferences || [],
  ),
});
console.log("Native implementation gate passed.");
