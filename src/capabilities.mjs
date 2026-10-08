import fs from "node:fs";
import path from "node:path";
import { ENGINE } from "./server.mjs";
import { nativeBinary } from "./media.mjs";
import { run } from "./process.mjs";
export async function nativeCapabilities() {
  const gate = path.join(ENGINE, "docs/native-gate.json");
  if (!fs.existsSync(gate) || !JSON.parse(fs.readFileSync(gate)).passed)
    return {
      available: false,
      reason:
        "Native gate: migration, reference and portable fixtures must pass",
      features: [],
    };
  try {
    return JSON.parse(await run(nativeBinary(), ["native-capabilities"]));
  } catch (e) {
    return { available: false, reason: e.message, features: [] };
  }
}
