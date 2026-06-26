// Apple Health export.xml → OpenBody Measurements (discrete/interval quantity, sleep
// category series) + HKWorkout → Session. Health Connect maps identically (documented
// parity); this mapper covers both shapes.
import { type OpenBodyRecord, type MapOptions } from "./csv.js";

const attrs = (el: string) => Object.fromEntries([...el.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const rfc = (s: string) => s.replace(" ", "T").replace(/ \+0000$/, "Z").replace(/ ([+-]\d\d)(\d\d)$/, "$1:$2");

const QTY: Record<string, string> = {
  HKQuantityTypeIdentifierHeartRate: "heart_rate",
  HKQuantityTypeIdentifierStepCount: "step_count",
  HKQuantityTypeIdentifierBodyMass: "body_mass",
};
const UNIT: Record<string, string> = { "count/min": "/min", count: "1" };
const DISC: Record<string, string> = { HKWorkoutActivityTypeRunning: "running", HKWorkoutActivityTypeCycling: "cycling" };
const typeFor = (hk: string, map: Record<string, string>) => map[hk] ?? "apple:" + hk;

/** Map an Apple Health export.xml string to OpenBody wire records. */
export function mapAppleHealth(xml: string, opts: MapOptions = {}): OpenBodyRecord[] {
  const subject = opts.subject ?? "subj-001";
  const records: OpenBodyRecord[] = [];
  const measuredBy: OpenBodyRecord[] = [];
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
      // §4.3: sleep stages are multiple category Measurements over adjacent intervals.
      const stage = a.value.replace("HKCategoryValueSleepAnalysis", "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      records.push({ id: "apple-sleep-" + i, recordType: "Measurement", subject, type: "sleep_stage",
        category: stage, startTime: rfc(a.startDate), endTime: rfc(a.endDate), provenance: prov });
    }
  }

  for (const m of xml.matchAll(/<Workout\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]); i++;
    const durSec = a.durationUnit === "min" ? Number(a.duration) * 60 : Number(a.duration);
    const perf: OpenBodyRecord = {};
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
  return records;
}
