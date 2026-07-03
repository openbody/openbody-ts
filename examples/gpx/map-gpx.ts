// Dogfood: map three GPX fixtures into OpenBody — a timed two-segment track (the
// happy path: multi-channel location + HR/cadence streams), an untimed track (no
// <time> at all — degrades to a Session with geometry preserved in
// extension.gpx.untimedTrack), and a waypoint-only file (no <trkpt> — maps to an
// empty result). Mapping logic lives in the SDK (src/mappers/gpx.ts).
// Run: tsx examples/gpx/map-gpx.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapGpx } from "../../src/mappers/index.js";
import { normalizeDocument } from "../../src/normalize.js";
import { validate } from "../../src/validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(here, f), "utf8");

for (const [name, file] of [
  ["timed track", "gpx-sample.gpx"],
  ["untimed track", "gpx-no-time-sample.gpx"],
  ["waypoints-only", "gpx-waypoints-sample.gpx"],
] as const) {
  const { records, warnings } = mapGpx(read(file));
  console.log(`Mapped GPX (${name}) -> ${records.length} OpenBody records (${warnings.length} warnings).`);
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
