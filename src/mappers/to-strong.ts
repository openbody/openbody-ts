// OpenBody Session/Exercise/WorkUnit records → a Strong-importable CSV file. This is the
// mirror of `mapStrong` (strong.ts): where that mapper reads Strong's export/import CSV
// shape into OpenBody wire records, this one writes that same CSV shape back out — and the
// output is round-trippable through `mapStrong` (Strong is also the CSV-import path into
// Hevy, which accepts Strong-format CSVs).
//
// What Strong's CSV can hold (and this mapper writes):
//   - reps ± an absolute load → Reps + Weight (kg; non-kg UCUM mass units are converted
//     with exact decimal arithmetic — no float rounding)
//   - bodyweight / reps-only sets → Reps with Weight 0
//   - duration-scored sets → Seconds (UCUM `s`/`min`/`h`/`ms` converted to seconds)
//   - distance-scored sets → Distance in metres (`mapStrong` reads Distance as `m`;
//     `km`/`cm`/`mm`/`[mi_i]`/`[yd_i]`/`[ft_i]`/`[in_i]` converted exactly)
//   - RPE → an RPE column (performance.effortLoad entries with method "RPE")
//   - per-set notes, workout name/date/duration, Strong's own Workout No (round-tripped
//     via the `io.strong.export` extension)
//
// Degradation policy (SPEC §10: emitting into a less-expressive target is best-effort and
// bounded by that target — a limit of Strong's CSV, not a defect of OpenBody). By default
// nothing throws: the mapper emits everything Strong can hold and returns a machine-readable
// `omissions` report ({ recordId, field?, reason }) covering every *material* loss, so a UI
// can say "N things Strong can't represent were left out". Reported as omissions:
//   - non-Session top-level records (Measurements, Programs, … — no CSV home)
//   - WorkUnits with no `exerciseRef` (Session.workUnits from telemetry mappers, bare Block
//     children) — Strong's CSV keys every row on an Exercise Name, so there is nothing to write
//   - Block structure: `grouping` (supersets), `roundScheme`, `repetitions`, block-level
//     `scoring` schemes (AMRAP/EMOM) — children are flattened to consecutive plain sets
//   - `scoring: "energy"`/`"continuous"` WorkUnits — emitted as plain sets where they carry
//     time/distance/reps, reported as simplified (dropped entirely when they carry nothing
//     Strong can hold)
//   - metric values Strong's columns can't take: `range`, `relativeToThreshold` (e.g. %1RM —
//     this mapper does not resolve ThresholdProfiles), `ramp`, `stopCondition`, `energy`
//     values, loads in units with no exact kg conversion (bands, machine levels)
//   - effortLoad entries other than a single-valued RPE
// Silently dropped (documented here once, not per row — Strong's CSV simply has no concept
// of them, and reporting each would drown the real losses): `setRole`, `rxStatus`,
// `prescription` (the CSV is a performed log), `repDetail`, `sides`, `phasePattern`,
// `modifiers`, `intensity`, `rest`, `outcome`, `terminatedBy`, per-WorkUnit timestamps,
// envelope metadata (links/media/provenance) and non-Strong extensions.
//
// `{ strict: true }` inverts the policy for programmatic users who prefer failure to loss:
// the first would-be omission throws instead.
import { type OpenBodyRecord, type MapOptions } from "./csv.js";
import { sourceNameForId } from "../resolve.js";
import { LosslessNumber } from "../parse.js";
import { canonNumber, isFixedPointLike } from "../canonical.js";

const HEADER = ["Date", "Workout Name", "Duration", "Exercise Name", "Set Order", "Weight", "Reps", "Distance", "Seconds", "Notes", "Workout No", "RPE"];

/** One thing Strong's CSV could not represent (dropped or simplified). */
export interface StrongOmission {
  /** `id` of the record the loss happened on (Session/Block/Exercise/WorkUnit), or "?" if it has none. */
  recordId: string;
  /** The field that was dropped/simplified (e.g. "load", "grouping"); absent when the whole record was skipped. */
  field?: string;
  /** Human-readable explanation, suitable for surfacing to end users. */
  reason: string;
}

export interface ToStrongResult {
  /** The Strong-importable CSV (round-trips through `mapStrong`). */
  csv: string;
  /** Everything that was dropped or simplified — empty when the mapping was faithful. */
  omissions: StrongOmission[];
}

export interface ToStrongOptions extends MapOptions {
  /** Throw on the first thing Strong's CSV cannot represent, instead of degrading + reporting. */
  strict?: boolean;
}

// RFC 3339 → Strong's offset-less "YYYY-MM-DD HH:MM:SS" (inverse of the `toRfc3339` step in
// strong.ts): the wall-clock part is kept and the offset/fractional seconds dropped —
// Strong's Date column has no offset concept.
function toStrongDate(iso: string | undefined): string {
  if (!iso) return "";
  return iso.replace("T", " ").replace(/\.\d+/, "").replace(/(?:Z|[+-]\d\d:\d\d)$/, "");
}

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// ---- exact decimal arithmetic ------------------------------------------------------------
// Wire numbers may be plain JS numbers, LosslessNumbers (parseLossless), or fixed-point
// {coefficient, exponent} objects. Conversions multiply by exact decimal factors (all the
// UCUM factors below are finite decimals), so kg/m/s conversion is lossless — no float64.

function fixedPointToPlain(coefficient: string, exponent: string): string {
  let coeff = BigInt(coefficient);
  const exp = Number(exponent);
  const neg = coeff < 0n;
  if (neg) coeff = -coeff;
  let s = coeff.toString();
  if (exp >= 0) s = s + "0".repeat(exp);
  else {
    const point = s.length + exp; // digits left of the decimal point
    s = point <= 0 ? "0." + "0".repeat(-point) + s : s.slice(0, point) + "." + s.slice(point);
  }
  return (neg ? "-" : "") + s;
}

/** Exact decimal `value × factor` as a plain decimal string; undefined if `v` isn't numeric. */
function decTimes(v: unknown, factor: string): string | undefined {
  let a: { coefficient: string; exponent: string };
  try {
    a = canonNumber(v as any);
  } catch {
    return undefined;
  }
  const b = canonNumber(new LosslessNumber(factor));
  return fixedPointToPlain(
    (BigInt(a.coefficient) * BigInt(b.coefficient)).toString(),
    String(Number(a.exponent) + Number(b.exponent)),
  );
}

// Exact decimal factors to Strong's column units (Weight: kg, Distance: m, Seconds: s).
const MASS_TO_KG: Record<string, string> = {
  kg: "1", g: "0.001", mg: "0.000001", "[lb_av]": "0.45359237", "[oz_av]": "0.028349523125",
};
const LENGTH_TO_M: Record<string, string> = {
  m: "1", km: "1000", cm: "0.01", mm: "0.001",
  "[mi_i]": "1609.344", "[yd_i]": "0.9144", "[ft_i]": "0.3048", "[in_i]": "0.0254",
};
const TIME_TO_S: Record<string, string> = { s: "1", min: "60", h: "3600", ms: "0.001" };

// ---- scalarOrTarget handling (§5.10) -----------------------------------------------------

/** Pull the scalar out of a metric value (bare scalar or `absolute` Target); every other
 * Target variant gets a `why` explaining what Strong's numeric columns can't take. */
function scalarPart(v: any): { raw?: unknown; unit?: string; why?: string } {
  if (v === null || v === undefined) return {};
  if (typeof v === "number" || v instanceof LosslessNumber || isFixedPointLike(v)) return { raw: v };
  if (typeof v === "object" && !Array.isArray(v)) {
    if ("absolute" in v) return { raw: v.absolute?.value, unit: v.absolute?.unit };
    if ("range" in v) return { why: "a min–max range" };
    if ("relativeToThreshold" in v) {
      const r = v.relativeToThreshold ?? {};
      const what = r.percent !== undefined ? `${r.percent}% of ${r.of ?? "a threshold"}` : `a band relative to ${r.of ?? "a threshold"}`;
      return { why: `${what} (this mapper does not resolve ThresholdProfiles to an absolute value)` };
    }
    if ("stopCondition" in v) return { why: "a stop-condition (e.g. to failure), not a number" };
    if ("ramp" in v) return { why: "a directional ramp, not a single value" };
  }
  return { why: "an unrecognized value shape" };
}

/** Convert a metric value to a plain decimal string in `targetUnit` using `factors`. */
function metricColumn(v: any, factors: Record<string, string>, defaultUnit: string, targetUnit: string): { out?: string; why?: string } {
  const p = scalarPart(v);
  if (p.why) return { why: `is ${p.why}` };
  if (p.raw === undefined) return {};
  const unit = p.unit ?? defaultUnit;
  const factor = factors[unit];
  if (factor === undefined) return { why: `uses unit "${unit}", which has no exact conversion to ${targetUnit}` };
  const out = decTimes(p.raw, factor);
  return out === undefined ? { why: "has a non-numeric value" } : { out };
}

/**
 * Map OpenBody wire records (Sessions of Exercises/WorkUnits) to a Strong-importable CSV.
 *
 * Covers everything Strong's CSV columns can hold — reps±weight, bodyweight, duration,
 * distance, RPE, notes — converting non-kg/m/s units with exact decimal math. Anything the
 * format can't represent degrades gracefully per the policy in this file's header and is
 * returned in `omissions` ({ recordId, field?, reason }); `csv` always holds everything that
 * *was* representable. Pass `{ strict: true }` to throw on the first loss instead.
 *
 * Exercise names prefer the lossless original source string (`opaque`, §6.1 — so
 * Hevy → OpenBody → Strong keeps the app's own names byte-for-byte), then Strong's own
 * alias for a resolved canonical id (`sourceNameForId`), then the raw id.
 */
export function mapOpenBodyToStrong(records: OpenBodyRecord[], opts: ToStrongOptions = {}): ToStrongResult {
  const omissions: StrongOmission[] = [];
  const omit = (recordId: string | undefined, field: string | undefined, reason: string) => {
    if (opts.strict) {
      throw new Error(`mapOpenBodyToStrong (strict): ${reason} [record ${recordId ?? "?"}${field ? `, field ${field}` : ""}] — omit \`strict\` to degrade gracefully and get an omissions report instead`);
    }
    omissions.push({ recordId: recordId ?? "?", ...(field ? { field } : {}), reason });
  };

  const rows: string[][] = [];
  let wIdx = 0;

  for (const session of records) {
    if (session.recordType !== "Session") {
      omit(session.id, undefined, `recordType "${session.recordType}" has no Strong CSV representation — record skipped`);
      continue;
    }
    wIdx++;

    const date = toStrongDate(session.startTime);
    const duration = session.startTime && session.endTime
      ? Math.round((new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 1000)
      : 0;
    const workoutNo = session.extension?.["io.strong.export"]?.workoutNo ?? String(wIdx);

    // Session.exercises passes through; Session.workUnits (the collapsed §5.1 hierarchy —
    // strava/fit/gpx/tcx/concept2/thecrag produce these) joins it where a unit names its own
    // exercise; Session.blocks flattens (§5.3 at-most-one container): Strong's flat CSV has
    // no superset/round concept, so Block children become consecutive plain sets and the
    // lost structure is reported.
    const exercises: OpenBodyRecord[] = [];
    const walk = (node: OpenBodyRecord) => {
      if (node?.recordType === "Exercise") exercises.push(node);
      else if (node?.recordType === "WorkUnit") {
        // A bare WorkUnit (Session.workUnits or a Block child) can stand alone only if it
        // names its own exercise.
        if (node.exerciseRef) exercises.push({ recordType: "Exercise", id: node.id, exerciseRef: node.exerciseRef, workUnits: [node] });
        else omit(node.id, "exerciseRef", "WorkUnit carries no exerciseRef — no Exercise Name to write; set dropped");
      } else if (node?.recordType === "Block") {
        if (node.grouping !== undefined) omit(node.id, "grouping", `Block grouping "${node.grouping}" flattened to consecutive plain sets — Strong CSV has no superset/group concept`);
        if (node.roundScheme !== undefined) omit(node.id, "roundScheme", `Block roundScheme [${node.roundScheme}] dropped — children emitted once; Strong CSV has no rounds`);
        if (node.repetitions !== undefined) omit(node.id, "repetitions", `Block repetitions (${node.repetitions}) dropped — children emitted once; Strong CSV has no rounds`);
        if (node.scoring !== undefined) omit(node.id, "scoring", `Block scoring scheme "${node.scoring?.scheme}" dropped — Strong CSV has no block-level schemes`);
        (node.children ?? []).forEach(walk);
      }
    };
    (session.exercises ?? []).forEach(walk);
    (session.blocks ?? []).forEach(walk);
    (session.workUnits ?? []).forEach(walk);

    for (const ex of exercises) {
      const er = ex.exerciseRef;
      const name =
        typeof er === "string"
          ? sourceNameForId(er, "strong") ?? er
          : er?.opaque ?? (er?.id ? sourceNameForId(er.id, "strong") ?? er.id : "");
      const workUnits: OpenBodyRecord[] = ex.workUnits ?? [];

      let setOrder = 0;
      for (const wu of workUnits) {
        if (wu.recordType !== "WorkUnit") continue;
        const wuId = wu.id;
        const perf = wu.performance ?? {};

        // Reps are dimensionless — no unit conversion, just the exact decimal.
        const repsPart = scalarPart(perf.reps);
        let reps: string | undefined;
        if (repsPart.why) omit(wuId, "reps", `reps is ${repsPart.why} — Reps column left at 0`);
        else if (repsPart.raw !== undefined) reps = decTimes(repsPart.raw, "1");

        // Weight: Load carries its unit on Load.unit (§5.12); an explicit inner `absolute`
        // unit wins if present. A bare scalar with no unit is kg (mirrors `mapStrong`).
        let weight: string | undefined;
        if (perf.load !== undefined) {
          const p = scalarPart(perf.load.value);
          if (p.why) omit(wuId, "load", `load is ${p.why} — Strong's Weight column needs an absolute kg value; left at 0`);
          else if (p.raw !== undefined) {
            const unit = p.unit ?? perf.load.unit ?? "kg";
            const factor = MASS_TO_KG[unit];
            if (factor === undefined) omit(wuId, "load", `load unit "${unit}" has no exact conversion to kg (band/machine-level loads have no Strong representation) — Weight left at 0`);
            else {
              weight = decTimes(p.raw, factor);
              if (weight === undefined) omit(wuId, "load", "load has a non-numeric value — Weight left at 0");
            }
          }
        }

        const dist = metricColumn(perf.distance, LENGTH_TO_M, "m", "metres");
        if (dist.why) omit(wuId, "distance", `distance ${dist.why} — Distance column left at 0`);

        const secs = metricColumn(perf.time, TIME_TO_S, "s", "seconds");
        if (secs.why) omit(wuId, "time", `time ${secs.why} — Seconds column left at 0`);

        if (perf.energy !== undefined) omit(wuId, "energy", "energy has no Strong CSV column — dropped");

        // RPE: the one effortLoad Strong can hold (single-valued, method "RPE").
        let rpe: string | undefined;
        for (const e of perf.effortLoad ?? []) {
          if (String(e.method).toUpperCase() === "RPE" && e.value !== undefined && rpe === undefined) rpe = decTimes(e.value, "1");
          else omit(wuId, "effortLoad", `effortLoad ${e.method ?? e.kind}${e.range ? " (range)" : ""} has no Strong CSV column (only a single RPE value) — dropped`);
        }

        if (reps === undefined && weight === undefined && dist.out === undefined && secs.out === undefined) {
          omit(wuId, undefined, `WorkUnit (scoring "${wu.scoring}") carries nothing Strong's columns can hold — set dropped`);
          continue;
        }
        if (wu.scoring === "energy" || wu.scoring === "continuous") {
          omit(wuId, "scoring", `scoring "${wu.scoring}" has no Strong equivalent — emitted as a plain set (re-imports as reps/distance/time-scored)`);
        }

        setOrder++;
        rows.push([
          date, session.name ?? "", String(duration), name, String(setOrder),
          weight ?? "0", reps ?? "0", dist.out ?? "0", secs.out ?? "0",
          wu.notes ?? "", String(workoutNo), rpe ?? "",
        ]);
      }
    }
  }

  const lines = [HEADER, ...rows].map((r) => r.map(csvEscape).join(","));
  return { csv: lines.join("\n") + "\n", omissions };
}
