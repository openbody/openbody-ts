// Apple Health export.xml → OpenBody Measurements (discrete/interval quantity, sleep
// category series) + HKWorkout → Session. Health Connect maps identically (documented
// parity); this mapper covers both shapes. Everything lives in element attributes
// (<Record .../> / <Workout .../> are usually self-closing), parsed with the shared
// regex-XML helpers (src/mappers/xml.ts — no DOM, zero deps).
import { MapperInputError } from "../errors.js";
import type { LiveRecord, MapOptions, MapperResult, MapWarning, Performance, Provenance } from "../types.js";
import { makeDisciplineMapper, subjectFor } from "./shared.js";
import { els, first } from "./xml.js";

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

/**
 * Map an Apple Health `export.xml` string (Android Health Connect maps identically —
 * see the file header) to OpenBody wire records: `<Record>` quantity types → discrete/
 * interval quantity Measurements, `HKCategoryTypeIdentifierSleepAnalysis` → adjacent
 * `sleep_stage` category Measurements (§4.3), `<Workout>` → a Session + continuous
 * WorkUnit, with in-window HR Measurements linked via `measuredBy`.
 *
 * Input precondition: the XML must contain a `<HealthData>` root — anything else
 * throws {@link MapperInputError} (`mapper: "apple-health"`). A structurally valid
 * export with no `<Record>`/`<Workout>` elements returns an empty result, not an
 * error.
 *
 * `opts.utcOffset` is not applicable: Apple Health's `startDate`/`endDate` attributes
 * already carry an offset (parsed via the file's local `rfc()` helper).
 *
 * Warnings this mapper can emit: `default-subject` (no `opts.subject` given),
 * `skipped-record` (a `<Record>`/`<Workout>` missing a required attribute — value/
 * startDate/endDate), `unmapped-record-types` (a `<Record>` type this mapper has no
 * encoding for, dropped and counted).
 */
export function mapAppleHealth(xml: string, opts: MapOptions = {}): MapperResult {
  // Structural minimum (WP7): a <HealthData> root. Without it this isn't an Apple
  // Health export.xml (or a Health Connect export); a valid export with no
  // <Record>/<Workout> elements stays a graceful empty result.
  if (first(xml, "HealthData") === undefined)
    throw new MapperInputError(
      "apple-health",
      "input contains no <HealthData> element — not an Apple Health export.xml",
    );

  const warnings: MapWarning[] = [];
  const subject = subjectFor(opts, warnings, "apple-health");
  const records: LiveRecord[] = [];
  const hrRecords: { ref: string; s: number; e: number }[] = [];
  // Elements dropped because this mapper has no encoding for their type — counted per
  // type and reported once (a real export carries thousands of unmapped-type Records).
  const unmappedTypes = new Map<string, number>();
  let i = 0;

  // A <Record>/<Workout> missing an attribute the encoding hangs off (its window, its
  // value) degrades to a skip + warning — emitting a record with a fabricated/NaN
  // field would be dishonest, and per the WP7 policy missing data never throws.
  const skip = (element: string, index: number, missing: string[]) => {
    warnings.push({
      code: "skipped-record",
      message: `<${element}> #${index} is missing required attribute(s) ${missing.join(", ")} — skipped`,
      context: { element, index, missing },
    });
  };
  const missingOf = (a: Record<string, string>, keys: string[]) => keys.filter((k) => !a[k]);

  for (const { attrs: a } of els(xml, "Record")) {
    i++;
    const prov: Provenance = {
      method: "sensor",
      sourceApp: "apple",
      device: { manufacturer: "apple", model: a.sourceName },
    };
    if (a.type?.startsWith("HKQuantityTypeIdentifier")) {
      const missing = missingOf(a, ["value", "startDate", "endDate"]);
      if (missing.length) {
        skip("Record", i, missing);
        continue;
      }
      // `missingOf` only rejects absent/blank `value`; a present-but-non-numeric one
      // (value="abc") would still land NaN in `quantity` — skip it (csv.ts num() discipline).
      const quantity = Number(a.value);
      if (!Number.isFinite(quantity)) {
        skip("Record", i, ["value"]);
        continue;
      }
      const id = `apple-q-${i}`;
      records.push({
        id,
        recordType: "Measurement",
        subject,
        type: qtyFor(a.type),
        quantity,
        unit: UNIT[a.unit ?? ""] ?? a.unit,
        startTime: rfc(a.startDate ?? ""),
        endTime: rfc(a.endDate ?? ""),
        provenance: prov,
      });
      if (a.type === "HKQuantityTypeIdentifierHeartRate")
        hrRecords.push({ ref: id, s: Date.parse(rfc(a.startDate ?? "")), e: Date.parse(rfc(a.endDate ?? "")) });
    } else if (a.type === "HKCategoryTypeIdentifierSleepAnalysis") {
      const missing = missingOf(a, ["value", "startDate", "endDate"]);
      if (missing.length) {
        skip("Record", i, missing);
        continue;
      }
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
    } else {
      // A <Record> type this mapper has no encoding for (other HKCategory*, clinical
      // records, …) — dropped, counted, reported once below.
      const t = a.type ?? "(no type)";
      unmappedTypes.set(t, (unmappedTypes.get(t) ?? 0) + 1);
    }
  }

  for (const { attrs: a } of els(xml, "Workout")) {
    i++;
    const missing = missingOf(a, ["startDate", "endDate"]);
    if (missing.length) {
      skip("Workout", i, missing);
      continue;
    }
    const start = rfc(a.startDate ?? ""),
      end = rfc(a.endDate ?? "");
    const durSec = a.durationUnit === "min" ? Number(a.duration) * 60 : Number(a.duration);
    const perf: Performance = {};
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

  if (unmappedTypes.size) {
    const total = [...unmappedTypes.values()].reduce((s, c) => s + c, 0);
    warnings.push({
      code: "unmapped-record-types",
      message: `${total} <Record> element(s) of ${unmappedTypes.size} type(s) this mapper has no encoding for were dropped`,
      context: { counts: Object.fromEntries(unmappedTypes) },
    });
  }
  return { records, warnings };
}
