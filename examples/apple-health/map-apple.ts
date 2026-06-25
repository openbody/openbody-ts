// Dogfooding: map an Apple Health export.xml into OpenBody, validate + normalize.
// Exercises paths Strava didn't: discrete quantity samples (instant + daily-interval
// aggregate), CATEGORY series (sleep stages -> multiple category Measurements, §4.3),
// and HKWorkout -> Session. Sample built from the documented export.xml structure.
// Run: tsx examples/apple-health/map-apple.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../src/validate.js";
import { normalizeDocument } from "../../src/normalize.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const xml = fs.readFileSync(path.join(here, "export-sample.xml"), "utf8");
const subject = "subj-001";

const attrs = (el: string) => Object.fromEntries([...el.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const rfc = (s: string) => s.replace(" ", "T").replace(/ \+0000$/, "Z").replace(/ ([+-]\d\d)(\d\d)$/, "$1:$2");

// HK identifier -> canonical token, else lazy source-namespaced (§4.4)
const QTY: Record<string, string> = {
  HKQuantityTypeIdentifierHeartRate: "heart_rate",
  HKQuantityTypeIdentifierStepCount: "step_count",
  HKQuantityTypeIdentifierBodyMass: "body_mass",
};
const UNIT: Record<string, string> = { "count/min": "/min", count: "1" };
const DISC: Record<string, string> = { HKWorkoutActivityTypeRunning: "running", HKWorkoutActivityTypeCycling: "cycling" };
const typeFor = (hk: string, map: Record<string, string>) => map[hk] ?? "apple:" + hk;

const records: any[] = [];
const measuredBy: any[] = [];
let i = 0;

for (const m of xml.matchAll(/<Record\b([^>]*?)\/?>/g)) {
  const a = attrs(m[1]); i++;
  const prov = { method: "sensor", sourceApp: "apple", device: { manufacturer: "apple", model: a.sourceName } };
  if (a.type?.startsWith("HKQuantityTypeIdentifier")) {
    const id = "apple-q-" + i;
    records.push({ id, recordType: "Measurement", subject, type: typeFor(a.type, QTY),
      quantity: Number(a.value), unit: UNIT[a.unit] ?? a.unit, startTime: rfc(a.startDate), endTime: rfc(a.endDate), provenance: prov });
    if (a.type === "HKQuantityTypeIdentifierHeartRate") measuredBy.push({ type: "measuredBy", ref: id });
  } else if (a.type === "HKCategoryTypeIdentifierSleepAnalysis") {
    // §4.3: sleep stages are MULTIPLE category Measurements over adjacent intervals (NOT a sampleArray).
    const stage = a.value.replace("HKCategoryValueSleepAnalysis", "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    records.push({ id: "apple-sleep-" + i, recordType: "Measurement", subject, type: "sleep_stage",
      category: stage, startTime: rfc(a.startDate), endTime: rfc(a.endDate), provenance: prov });
  }
}

for (const m of xml.matchAll(/<Workout\b([^>]*?)\/?>/g)) {
  const a = attrs(m[1]); i++;
  const durSec = a.durationUnit === "min" ? Number(a.duration) * 60 : Number(a.duration);
  const perf: any = {};
  if (a.totalDistance) perf.distance = { absolute: { value: Number(a.totalDistance), unit: a.totalDistanceUnit } };
  if (a.totalEnergyBurned) perf.energy = { absolute: { value: Number(a.totalEnergyBurned), unit: a.totalEnergyBurnedUnit } };
  perf.time = { absolute: { value: durSec, unit: "s" } };
  records.push({
    id: "apple-workout-" + i, recordType: "Session", subject,
    disciplines: [typeFor(a.workoutActivityType, DISC)], intent: "train",
    startTime: rfc(a.startDate), endTime: rfc(a.endDate),
    provenance: { method: "sensor", sourceApp: "apple", device: { manufacturer: "apple", model: a.sourceName } },
    workUnits: [{ id: "apple-workout-" + i + "-wu", recordType: "WorkUnit", scoring: "continuous", performance: perf, links: measuredBy }],
  });
}

console.log(`Mapped Apple Health export -> ${records.length} OpenBody records.\n`);
let bad = 0;
for (const r of records) {
  const v = validate(r);
  console.log(`  ${v.valid ? "ok  " : "FAIL"} ${r.recordType} ${r.id} (${r.type ?? r.disciplines?.[0]}${r.category ? "=" + r.category : ""})${v.valid ? "" : " — " + v.errors}`);
  if (!v.valid) bad++;
}
console.log(bad ? `\n${bad} invalid` : `\nAll ${records.length} wire records validate against the schema. ✅`);
console.log(`Normalized to ${normalizeDocument(records).length} flat canonical records.`);
