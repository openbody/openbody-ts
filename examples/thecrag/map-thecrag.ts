// Map a theCrag logbook CSV export into OpenBody, then validate + normalize it.
// The mapping logic lives in the SDK (src/mappers/thecrag.ts); this just runs it.
// Run: npx tsx examples/thecrag/map-thecrag.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapTheCrag } from "../../src/mappers/thecrag.js";
import { normalizeDocument } from "../../src/normalize.js";
import { validate } from "../../src/schema-loader-node.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const { records, warnings } = mapTheCrag(fs.readFileSync(path.join(here, "thecrag-sample.csv"), "utf8"));

console.log(
  `Mapped theCrag logbook CSV -> ${records.length} OpenBody Session record(s) (${warnings.length} warnings).\n`,
);
for (const w of warnings) console.log(`  warn ${w.code}: ${w.message}`);
console.log(`Session JSON (wire form):\n${JSON.stringify(records[0], null, 2)}\n`);

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
