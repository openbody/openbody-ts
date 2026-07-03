// Dogfood the outbound direction: OpenBody → Strong-importable CSV (also the CSV-import
// path into Hevy, which accepts Strong-format files). Mapping logic lives in the SDK
// (src/mappers/to-strong.ts). Run: tsx examples/strong/to-strong.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapOpenBodyToStrong, mapStrong } from "../../src/mappers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const records = mapStrong(fs.readFileSync(path.join(here, "strong-sample.csv"), "utf8"));

// Faithful case: everything in the sample fits Strong's columns → zero omissions.
const out = mapOpenBodyToStrong(records);
console.log(`OpenBody -> Strong CSV:\n\n${out.csv}`);
console.log(`Omissions: ${out.omissions.length} (fixture is fully representable)\n`);

// Degraded case: a %1RM load has no absolute kg value Strong can hold. The set is still
// emitted (reps survive) and the loss is reported machine-readably — SPEC §10's
// directional-lossless rule. `{ strict: true }` would throw here instead.
records[0].exercises[0].workUnits[0].performance.load = {
  value: { relativeToThreshold: { percent: 80, of: "1RM" } },
  basis: "marked_weight",
};
const degraded = mapOpenBodyToStrong(records);
console.log("With a %1RM load injected:");
console.log(JSON.stringify(degraded.omissions, null, 2));
