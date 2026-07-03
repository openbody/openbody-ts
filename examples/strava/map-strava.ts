// Dogfood: map a real-shaped Strava activity + streams into OpenBody (Pillar A
// Measurements + a Pillar B Session linked by measuredBy), then validate + normalize.
// Mapping logic lives in the SDK (src/mappers/strava.ts). Run: tsx examples/strava/map-strava.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapStrava } from "../../src/mappers/index.js";
import { normalizeDocument } from "../../src/normalize.js";
import { validate } from "../../src/validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(fs.readFileSync(path.join(here, "strava-sample.json"), "utf8"));
const { records, warnings } = mapStrava(input, { subject: "athlete-1" });
const session = records[records.length - 1];

console.log(`Mapped Strava activity -> ${records.length} OpenBody records (${warnings.length} warnings).\n`);
for (const w of warnings) console.log(`  warn ${w.code}: ${w.message}`);
console.log(`Session (wire):\n${JSON.stringify(session, null, 2)}\n`);
let bad = 0;
for (const r of records) {
  const v = validate(r);
  console.log(`  ${v.valid ? "ok  " : "FAIL"} ${r.recordType} ${r.id}${v.valid ? "" : ` — ${v.errors}`}`);
  if (!v.valid) bad++;
}
console.log(bad ? `\n${bad} wire record(s) invalid` : `\nAll ${records.length} wire records validate. ✅`);
console.log(`\nNormalized to ${normalizeDocument(records).length} flat canonical records (round-trip ok).`);
