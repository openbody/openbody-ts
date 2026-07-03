// Apple Health export.xml → OpenBody Measurements (discrete/interval quantity, sleep
// category series) + HKWorkout → Session. Health Connect maps identically (documented
// parity); this mapper covers both shapes. Everything lives in element attributes
// (<Record .../> / <Workout .../> are usually self-closing), parsed with the shared
// regex-XML helpers (src/mappers/xml.ts — no DOM, zero deps).
import type { MapOptions, OpenBodyRecord } from "../types.js";
import { makeDisciplineMapper } from "./shared.js";
import { els } from "./xml.js";

const rfc = (s: string) =>
  s
    .replace(" ", "T")
    .replace(/ \+0000$/, "Z")
    .replace(/ ([+-]\d\d)(\d\d)$/, "$1:$2");

const QTY: Record<string, string> = {
  HKQuantityTypeIdentifierHeartRate: "heart_rate",
  HKQuantityTypeIdentifierStepCount: "step_count",
  HKQuantityTypeIdentifierBodyMass: "body_mass",
};
const UNIT: Record<string, string> = { "count/min": "/min", count: "1" };
const DISC: Record<string, string> = {
  HKWorkoutActivityTypeRunning: "running",
  HKWorkoutActivityTypeCycling: "cycling",
};
// HK identifiers → registry tokens with an apple: namespaced fallback (§4.4 ladder);
// the shared mechanism serves both the quantity-type and the workout-discipline map.
const qtyFor = makeDisciplineMapper(QTY, "apple");
const discFor = makeDisciplineMapper(DISC, "apple");

/** Map an Apple Health export.xml string to OpenBody wire records. */
export function mapAppleHealth(xml: string, opts: MapOptions = {}): OpenBodyRecord[] {
  const subject = opts.subject ?? "subj-001";
  const records: OpenBodyRecord[] = [];
  const hrRecords: { ref: string; s: number; e: number }[] = [];
  let i = 0;

  for (const { attrs: a } of els(xml, "Record")) {
    i++;
    const prov = { method: "sensor", sourceApp: "apple", device: { manufacturer: "apple", model: a.sourceName } };
    if (a.type?.startsWith("HKQuantityTypeIdentifier")) {
      const id = `apple-q-${i}`;
      records.push({
        id,
        recordType: "Measurement",
        subject,
        type: qtyFor(a.type),
        quantity: Number(a.value),
        unit: UNIT[a.unit ?? ""] ?? a.unit,
        startTime: rfc(a.startDate ?? ""),
        endTime: rfc(a.endDate ?? ""),
        provenance: prov,
      });
      if (a.type === "HKQuantityTypeIdentifierHeartRate")
        hrRecords.push({ ref: id, s: Date.parse(rfc(a.startDate ?? "")), e: Date.parse(rfc(a.endDate ?? "")) });
    } else if (a.type === "HKCategoryTypeIdentifierSleepAnalysis") {
      // §4.3: sleep stages are multiple category Measurements over adjacent intervals.
      const stage = (a.value ?? "")
        .replace("HKCategoryValueSleepAnalysis", "")
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .toLowerCase();
      records.push({
        id: `apple-sleep-${i}`,
        recordType: "Measurement",
        subject,
        type: "sleep_stage",
        category: stage,
        startTime: rfc(a.startDate ?? ""),
        endTime: rfc(a.endDate ?? ""),
        provenance: prov,
      });
    }
  }

  for (const { attrs: a } of els(xml, "Workout")) {
    i++;
    const start = rfc(a.startDate ?? ""),
      end = rfc(a.endDate ?? "");
    const durSec = a.durationUnit === "min" ? Number(a.duration) * 60 : Number(a.duration);
    const perf: OpenBodyRecord = {};
    if (a.totalDistance) perf.distance = { absolute: { value: Number(a.totalDistance), unit: a.totalDistanceUnit } };
    if (a.totalEnergyBurned)
      perf.energy = { absolute: { value: Number(a.totalEnergyBurned), unit: a.totalEnergyBurnedUnit } };
    if (Number.isFinite(durSec)) perf.time = { absolute: { value: durSec, unit: "s" } }; // duration attr may be absent
    // §7.2 measuredBy: only the HR records whose window falls inside THIS workout's window —
    // linking every <Record> in the export to every workout would fabricate associations.
    const ws = Date.parse(start),
      we = Date.parse(end);
    const measuredBy = hrRecords.filter((h) => h.s >= ws && h.e <= we).map((h) => ({ type: "measuredBy", ref: h.ref }));
    records.push({
      id: `apple-workout-${i}`,
      recordType: "Session",
      subject,
      disciplines: [discFor(a.workoutActivityType ?? "")],
      intent: "train",
      startTime: start,
      endTime: end,
      provenance: { method: "sensor", sourceApp: "apple", device: { manufacturer: "apple", model: a.sourceName } },
      workUnits: [
        {
          id: `apple-workout-${i}-wu`,
          recordType: "WorkUnit",
          scoring: "continuous",
          performance: perf,
          ...(measuredBy.length ? { links: measuredBy } : {}),
        },
      ],
    });
  }
  return records;
}
