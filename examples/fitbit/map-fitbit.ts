// Dogfood: map a constructed Google Takeout Fitbit folder (six files spanning
// exercise/steps/heart_rate/sleep/weight/resting_heart_rate) into OpenBody, then
// validate + normalize. Mapping logic lives in the SDK (src/mappers/fitbit.ts).
// Run: tsx examples/fitbit/map-fitbit.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapFitbitTakeout } from "../../src/mappers/index.js";
import { normalizeDocument } from "../../src/normalize.js";
import { validate } from "../../src/validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  "exercise-0.json",
  "steps-2024-01-06.json",
  "heart_rate-2024-01-06.json",
  "sleep-2024-01-01.json",
  "weight-2024-01-01.json",
  "resting_heart_rate-2024-01-01.json",
];
const files = FILES.map((name) => ({ name, text: fs.readFileSync(path.join(here, name), "utf8") }));

const { records, warnings } = mapFitbitTakeout(files, { subject: "athlete-1" });
console.log(
  `Mapped ${FILES.length} Takeout files -> ${records.length} OpenBody records (${warnings.length} warnings).\n`,
);
for (const w of warnings) console.log(`  warn ${w.code}: ${w.message}`);

let bad = 0;
for (const r of records) {
  const v = validate(r);
  if (!v.valid) {
    bad++;
    console.log(`  FAIL ${r.recordType} ${r.id}: ${v.errors}`);
  }
}
console.log(bad ? `\n${bad} wire record(s) invalid` : `\nAll ${records.length} wire records validate. ✅`);
console.log(`Normalized to ${normalizeDocument(records).length} flat canonical records (round-trip ok).`);
