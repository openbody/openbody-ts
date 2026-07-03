// Dogfood: map a REAL Hevy CSV export into OpenBody, then validate + normalize it.
// The mapping logic now lives in the SDK (src/mappers/hevy.ts); this just runs it.
// Run: tsx examples/hevy/map-hevy.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapHevy } from "../../src/mappers/index.js";
import { normalizeDocument } from "../../src/normalize.js";
import { validate } from "../../src/validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const records = mapHevy(fs.readFileSync(path.join(here, "hevy-sample.csv"), "utf8"));

console.log(`Mapped Hevy CSV -> ${records.length} OpenBody Session record(s).\n`);
console.log(`Session JSON (wire form):\n${JSON.stringify(records[0], null, 2)}\n`);

let bad = 0;
for (const rec of records) {
  const v = validate(rec);
  if (!v.valid) {
    bad++;
    console.log(`  FAIL wire ${rec.recordType} ${rec.id}: ${v.errors}`);
  }
}
console.log(bad ? `${bad} wire record(s) invalid` : `All ${records.length} wire record(s) validate. ✅`);

const canonical = normalizeDocument(records);
console.log(`\nNormalized to ${canonical.length} flat canonical records (string fixed-point; comparison form).`);
