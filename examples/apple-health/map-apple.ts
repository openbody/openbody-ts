// Dogfood: map an Apple Health export.xml into OpenBody, validate + normalize.
// Exercises paths Strava didn't: discrete quantity samples, CATEGORY series (sleep
// stages, §4.3), and HKWorkout -> Session. Health Connect maps identically.
// Mapping logic lives in the SDK (src/mappers/apple-health.ts). Run: tsx examples/apple-health/map-apple.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapAppleHealth } from "../../src/mappers/index.js";
import { normalizeDocument } from "../../src/normalize.js";
import { validate } from "../../src/validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const records = mapAppleHealth(fs.readFileSync(path.join(here, "export-sample.xml"), "utf8"));

console.log(`Mapped Apple Health export -> ${records.length} OpenBody records.\n`);
let bad = 0;
for (const r of records) {
  const v = validate(r);
  console.log(
    `  ${v.valid ? "ok  " : "FAIL"} ${r.recordType} ${r.id} (${r.type ?? r.disciplines?.[0]}${r.category ? `=${r.category}` : ""})${v.valid ? "" : ` — ${v.errors}`}`,
  );
  if (!v.valid) bad++;
}
console.log(bad ? `\n${bad} invalid` : `\nAll ${records.length} wire records validate. ✅`);
console.log(`Normalized to ${normalizeDocument(records).length} flat canonical records.`);
