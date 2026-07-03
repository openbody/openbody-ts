// Map a Concept2 Logbook season CSV export into OpenBody, then validate + normalize it.
// The mapping logic lives in the SDK (src/mappers/concept2.ts); this just runs it.
// Run: npx tsx examples/concept2/map-concept2.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../src/schema-loader-node.js";
import { normalizeDocument } from "../../src/normalize.js";
import { mapConcept2 } from "../../src/mappers/concept2.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const records = mapConcept2(fs.readFileSync(path.join(here, "concept2-season-sample.csv"), "utf8"));

console.log(`Mapped Concept2 season CSV -> ${records.length} OpenBody record(s).\n`);
const intervals = records.find((r) => r.recordType === "Session" && r.blocks);
console.log("Interval Session JSON (wire form):\n" + JSON.stringify(intervals, null, 2) + "\n");

let bad = 0;
for (const rec of records) {
  const v = validate(rec);
  if (!v.valid) {
    bad++;
    console.log(`  FAIL wire ${rec.recordType} ${rec.id}: ${v.errors}`);
  }
}
console.log(bad ? `${bad} wire record(s) invalid` : `All ${records.length} wire record(s) validate.`);

const canonical = normalizeDocument(records);
console.log(`Normalized to ${canonical.length} flat canonical records.`);
