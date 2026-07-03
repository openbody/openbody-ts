// Dogfood: map a real-shaped TCX (Garmin Training Center) export into OpenBody — one
// Activity -> Session, two Laps -> continuous WorkUnits (the second an Intensity
// "Resting" recovery interval), Trackpoint streams -> sampleArray Measurements
// (HR/cadence/power/location), plus per-lap HR aggregates. Mapping logic lives in the
// SDK (src/mappers/tcx.ts). Run: tsx examples/tcx/map-tcx.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapTcx } from "../../src/mappers/index.js";
import { normalizeDocument } from "../../src/normalize.js";
import { validate } from "../../src/validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const { records, warnings } = mapTcx(fs.readFileSync(path.join(here, "tcx-sample.tcx"), "utf8"));

console.log(`Mapped TCX activity -> ${records.length} OpenBody records (${warnings.length} warnings).\n`);
for (const w of warnings) console.log(`  warn ${w.code}: ${w.message}`);
const session = records.find((r) => r.recordType === "Session");
console.log(`Session (wire):\n${JSON.stringify(session, null, 2)}\n`);

let bad = 0;
for (const r of records) {
  const v = validate(r);
  console.log(`  ${v.valid ? "ok  " : "FAIL"} ${r.recordType} ${r.id}${v.valid ? "" : ` — ${v.errors}`}`);
  if (!v.valid) bad++;
}
console.log(bad ? `\n${bad} wire record(s) invalid` : `\nAll ${records.length} wire records validate. ✅`);
console.log(`\nNormalized to ${normalizeDocument(records).length} flat canonical records (round-trip ok).`);
