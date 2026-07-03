// Dogfood: map a Strong app CSV export into OpenBody, validate + normalize.
// Mapping logic lives in the SDK (src/mappers/strong.ts). Run: tsx examples/strong/map-strong.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapStrong } from "../../src/mappers/index.js";
import { normalizeDocument } from "../../src/normalize.js";
import { validate } from "../../src/validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const { records, warnings } = mapStrong(fs.readFileSync(path.join(here, "strong-sample.csv"), "utf8"));

console.log(`Mapped Strong CSV -> ${records.length} OpenBody Session(s) (${warnings.length} warnings).\n`);
for (const w of warnings) console.log(`  warn ${w.code}: ${w.message}`);
console.log(`Session (wire):\n${JSON.stringify(records[0], null, 2)}\n`);
let bad = 0;
for (const r of records) {
  const v = validate(r);
  if (!v.valid) {
    bad++;
    console.log(`  FAIL ${r.id}: ${v.errors}`);
  }
}
console.log(bad ? `${bad} invalid` : `All ${records.length} wire record(s) validate. ✅`);
console.log(`Normalized to ${normalizeDocument(records).length} flat canonical records.`);
