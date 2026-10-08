import fs from "node:fs";
import path from "node:path";
const file = process.argv[2];
if (!file) throw Error("Usage: node tools/migrate-manifest.mjs <manifest>");
const m = JSON.parse(fs.readFileSync(file));
if (m.schemaVersion === 1) {
  console.log("Already schema 1");
  process.exit(0);
}
if (m.schemaVersion !== undefined)
  throw Error(`No migration available from schema ${m.schemaVersion}`);
const backup = `${file}.${Date.now()}.bak`;
fs.copyFileSync(file, backup);
const next = {
  schemaVersion: 1,
  apiVersion: "0.1.0",
  renderer: "browser-only",
  ...m,
};
const temp = file + ".part";
fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n");
fs.renameSync(temp, file);
console.log(`Migrated schema 0 to 1. Backup: ${backup}`);
