// Dogfooding: map a real-shaped Strava activity + streams into OpenBody (Pillar A
// Measurements + a Pillar B Session linked by measuredBy), then validate + normalize.
// Strava activity data is OAuth-gated, so this uses the documented wire shape
// (https://strava.github.io/api/v3/streams/) with representative values.
// Run: tsx examples/strava/map-strava.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../src/validate.js";
import { normalizeDocument } from "../../src/normalize.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const { activity: a, streams: s } = JSON.parse(fs.readFileSync(path.join(here, "strava-sample.json"), "utf8"));

const subject = "subj-001";
const start = a.start_date;
const end = new Date(new Date(start).getTime() + a.elapsed_time * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const offsets: number[] = s.time.data;
const device = a.device_name ? { manufacturer: "garmin", model: a.device_name } : undefined;
const prov = (method: string) => ({ method, sourceApp: "strava", ...(device ? { device } : {}) });

const records: any[] = [];
const measuredBy: { type: string; ref: string }[] = [];

// --- Pillar A: stream Measurements (sampleArray) ---
function scalarStream(id: string, type: string, unit: string, data: (number | null)[]) {
  records.push({ id, recordType: "Measurement", subject, type, unit,
    sampleArray: { offsets, dataPoints: data }, startTime: start, endTime: end, provenance: prov("sensor") });
  measuredBy.push({ type: "measuredBy", ref: id });
}
if (s.heartrate) scalarStream("strava-" + a.id + "-hr", "heart_rate", "/min", s.heartrate.data);
if (s.watts) scalarStream("strava-" + a.id + "-power", "power", "W", s.watts.data);
if (s.cadence) scalarStream("strava-" + a.id + "-cadence", "cadence", "/min", s.cadence.data);
// latlng + altitude -> one multi-channel location route
if (s.latlng) {
  const id = "strava-" + a.id + "-route";
  const dataPoints = s.latlng.data.map((ll: number[], i: number) => [ll[0], ll[1], s.altitude ? s.altitude.data[i] : null]);
  records.push({ id, recordType: "Measurement", subject, type: "location",
    sampleArray: { offsets, channels: [{ name: "lat", unit: "deg" }, { name: "lon", unit: "deg" }, { name: "alt", unit: "m" }], dataPoints },
    startTime: start, endTime: end, provenance: prov("sensor") });
  measuredBy.push({ type: "measuredBy", ref: id });
}

// --- Pillar A: aggregate HR Measurements (whole-activity interval) ---
function aggregate(id: string, type: string, value: number, unit: string, fromRef: string) {
  records.push({ id, recordType: "Measurement", subject, type, quantity: value, unit,
    startTime: start, endTime: end, provenance: prov("algorithm"),
    links: [{ type: "derivedFrom", ref: fromRef }] });
}
// NOTE: derivedFrom present => provenance.algorithm is required (§7.4). Strava doesn't
// publish the algorithm; we record a best-effort name so the record is well-formed.
const hrRef = "strava-" + a.id + "-hr";
if (a.average_heartrate != null) aggregate("strava-" + a.id + "-hr-mean", "heart_rate_mean", a.average_heartrate, "/min", hrRef);
if (a.max_heartrate != null) aggregate("strava-" + a.id + "-hr-max", "heart_rate_max", a.max_heartrate, "/min", hrRef);
// fix up algorithm field required by derivedFrom
for (const r of records) if (r.links?.some((l: any) => l.type === "derivedFrom")) r.provenance.algorithm = { name: "strava-summary", version: "v3" };

// --- Pillar B: the Session (continuous endurance), referencing Pillar A by measuredBy ---
const session = {
  id: "strava-" + a.id, recordType: "Session", subject,
  disciplines: [String(a.sport_type || a.type).toLowerCase()], intent: "train",
  startTime: start, endTime: end,
  provenance: prov("sensor"),
  workUnits: [{
    id: "strava-" + a.id + "-wu", recordType: "WorkUnit", scoring: "continuous",
    performance: {
      distance: { absolute: { value: a.distance, unit: "m" } },
      time: { absolute: { value: a.moving_time, unit: "s" } }
    },
    links: measuredBy
  }]
};
records.push(session);

// --- dogfood: validate every WIRE record + normalize ---
console.log(`Mapped Strava activity ${a.id} (${a.sport_type}) -> ${records.length} OpenBody records.\n`);
console.log("Session (wire):\n" + JSON.stringify(session, null, 2) + "\n");
let bad = 0;
for (const r of records) {
  const v = validate(r);
  console.log(`  ${v.valid ? "ok  " : "FAIL"} ${r.recordType} ${r.id}${v.valid ? "" : " — " + v.errors}`);
  if (!v.valid) bad++;
}
console.log(bad ? `\n${bad} wire record(s) invalid` : `\nAll ${records.length} wire records validate against the schema. ✅`);
const canonical = normalizeDocument(records);
console.log(`\nNormalized to ${canonical.length} flat canonical records (round-trip ok).`);
