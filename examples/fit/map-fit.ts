// Dogfood: map a decoded FIT activity and a decoded FIT structured workout into OpenBody.
// Mapping logic lives in the SDK (src/mappers/fit.ts). This repo hand-authors the decoded
// fixtures directly (matching the shape a real FIT decoder, e.g. `fit-file-parser`, produces
// in `mode: "list"`) rather than depending on one — see fit.ts's file header for why.
// Run: tsx examples/fit/map-fit.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapFit } from "../../src/mappers/index.js";
import { normalizeDocument } from "../../src/normalize.js";
import { validate } from "../../src/validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(here, f), "utf8"));

for (const [name, file] of [
  ["activity", "fit-activity-sample.json"],
  ["workout", "fit-workout-sample.json"],
] as const) {
  const { records, warnings } = mapFit(read(file));
  console.log(`Mapped FIT ${name} -> ${records.length} OpenBody records (${warnings.length} warnings).\n`);
  for (const w of warnings) console.log(`  warn ${w.code}: ${w.message}`);
  let bad = 0;
  for (const r of records) {
    const v = validate(r);
    console.log(`  ${v.valid ? "ok  " : "FAIL"} ${r.recordType} ${r.id}${v.valid ? "" : ` — ${v.errors}`}`);
    if (!v.valid) bad++;
  }
  console.log(bad ? `${bad} wire record(s) invalid` : `All ${records.length} wire records validate. ✅`);
  console.log(`Normalized to ${normalizeDocument(records).length} flat canonical records (round-trip ok).\n`);
}
