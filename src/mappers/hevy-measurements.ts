// Hevy `measurement_data.csv` export → OpenBody Pillar-A Measurement records (the body
// metrics Hevy logs alongside workouts; separate from the workout export mapped by
// mapHevy in ./hevy.ts). One Measurement per NON-EMPTY metric cell per row; each is a
// point-in-time observation (startTime == endTime == that instant).
//
// Input shape (real export header — verified against TWO real third-party exports):
//   date,weight_kg,fat_percent,neck_<u>,shoulder_<u>,chest_<u>,left_bicep_<u>,
//   right_bicep_<u>,left_forearm_<u>,right_forearm_<u>,abdomen_<u>,waist_<u>,hips_<u>,
//   left_thigh_<u>,right_thigh_<u>,left_calf_<u>,right_calf_<u>
// `date` is Hevy's offset-less local wall-clock "9 Feb 2023, 00:00"; most cells on a given
// row are blank (only the metrics recorded that day are filled).
//
// UNITS — the bug this mapper was reworked to fix. `weight_kg` is ALWAYS kilograms and
// `fat_percent` is always a unitless percent, in every export. But Hevy names the
// circumference columns by the USER'S CHOSEN LENGTH UNIT: the founder's own export uses
// `_in` inches (`neck_in/chest_in/…`); a second real user's export
// (200ok-ch/hevy_measurements_visualizer) uses `_cm` centimetres (`neck_cm/shoulder_cm/…`).
// The previous mapper hardcoded the `_in` columns, so a metric-unit user's circumferences
// matched nothing and were SILENTLY DROPPED. We now derive the OpenBody Measurement `type`
// from the column STEM and the `unit` from the SUFFIX: `<stem>_in` → unit `[in_i]` (UCUM
// international inch), `<stem>_cm` → unit `cm`.
//
// Measurement.type token choices (§4.4/§5.9 open-token ladder), all CANONICAL against the
// sibling registry (openbody-registry vocab/measurements/):
//   - weight_kg   → `body_mass` (kg)                — body-composition.json
//   - fat_percent → `body_fat_percentage` (%)       — body-composition.json
//   - every circumference stem → the canonical, SIDE-AGNOSTIC anthropometry token
//     (anthropometry.json), unit-agnostic, with the length unit on Measurement.unit (column
//     suffix) and the side, when any, on Measurement.laterality (column `left_`/`right_` prefix):
//       neck→neck_circumference, shoulder→shoulder_circumference, chest→chest_circumference,
//       abdomen→abdomen_circumference, waist→waist_circumference, hips→hip_circumference,
//       left_bicep→(bicep_circumference, left), right_bicep→(bicep_circumference, right),
//       left_forearm→(forearm_circumference, left), right_forearm→(forearm_circumference, right),
//       left_thigh→(thigh_circumference, left), right_thigh→(thigh_circumference, right),
//       left_calf→(calf_circumference, left), right_calf→(calf_circumference, right).
// The `hevy:` namespace is gone — every mapped type is now a canonical registry token.
//
// LATERALITY: as of SPEC §4.1 (v0.9.0) a limb girth's side is a first-class Measurement FIELD
// (`laterality`, closed enum `left｜right｜bilateral`), NOT a token suffix. So `left_bicep_cm`
// maps to type `bicep_circumference` + `laterality: "left"`; the type names the girth only.
// Non-lateral (midline/axial) girths (neck/waist/…) omit `laterality`.
//
// UNRECOGNIZED COLUMNS: because the two real exports differ only in the circumference length
// unit, format drift is a real risk (a new unit spelling, a renamed/added metric). Rather
// than drop such a column silently — the exact failure mode of the bug above — any header
// column that is neither `date` nor a recognized metric column raises a one-time
// `unrecognized-column` MapWarning, so drift SURFACES.
//
// `opts.utcOffset` stamps the offset-less `date` (default "Z"), consistent with the other
// CSV mappers. Numbers are kept as exact §4.2 fixed-point straight from the cell text
// (fitbit.ts `fixed` discipline) — no float round-trip. Provenance is manual/hevy (these
// are hand-logged body metrics).
import { MapperInputError } from "../errors.js";
import type { LiveRecord, MapOptions, MapperResult, MapWarning, Provenance, WireNumber } from "../types.js";
import { parseCsvDoc, requireColumns, toRfc3339 } from "./csv.js";
import { subjectFor } from "./shared.js";

/** The body side a Measurement pertains to (§4.1, closed enum). */
type Laterality = "left" | "right" | "bilateral";

/**
 * How one CSV metric column maps onto a Measurement: a canonical registry type + its unit,
 * plus (for a side-bearing girth) the `laterality` field the side lives on (§4.1).
 */
interface MetricSpec {
  type: string;
  unit: string;
  laterality?: Laterality;
}

// Fixed metric columns — unit is baked into the Hevy column name and never varies.
const FIXED_METRICS: Record<string, MetricSpec> = {
  weight_kg: { type: "body_mass", unit: "kg" },
  fat_percent: { type: "body_fat_percentage", unit: "%" },
};

// Circumference column STEM → side-agnostic anthropometry token + optional laterality (§4.1).
// The side, when the column carries a `left_`/`right_` prefix, becomes Measurement.laterality;
// midline/axial girths (neck/shoulder/chest/abdomen/waist/hips) have no side.
const CIRCUMFERENCE_TOKEN: Record<string, { type: string; laterality?: Laterality }> = {
  neck: { type: "neck_circumference" },
  shoulder: { type: "shoulder_circumference" },
  chest: { type: "chest_circumference" },
  abdomen: { type: "abdomen_circumference" },
  waist: { type: "waist_circumference" },
  hips: { type: "hip_circumference" },
  left_bicep: { type: "bicep_circumference", laterality: "left" },
  right_bicep: { type: "bicep_circumference", laterality: "right" },
  left_forearm: { type: "forearm_circumference", laterality: "left" },
  right_forearm: { type: "forearm_circumference", laterality: "right" },
  left_thigh: { type: "thigh_circumference", laterality: "left" },
  right_thigh: { type: "thigh_circumference", laterality: "right" },
  left_calf: { type: "calf_circumference", laterality: "left" },
  right_calf: { type: "calf_circumference", laterality: "right" },
};

// Circumference column SUFFIX → UCUM unit. The suffix follows the user's Hevy length setting.
const UNIT_BY_SUFFIX: Record<string, string> = { in: "[in_i]", cm: "cm" };

/**
 * Resolve a CSV header column to its Measurement mapping, or `undefined` if the column is
 * not a recognized metric (`date`, or genuinely unknown → surfaced as `unrecognized-column`).
 * Circumference types come from the column stem; the unit from the `_in`/`_cm` suffix.
 */
function specForColumn(col: string): MetricSpec | undefined {
  const fixed = FIXED_METRICS[col];
  if (fixed !== undefined) return fixed;
  const m = col.match(/^(.+)_(in|cm)$/);
  if (m === null) return undefined;
  const [, stem, suffix] = m;
  if (stem === undefined || suffix === undefined) return undefined;
  const girth = CIRCUMFERENCE_TOKEN[stem];
  const unit = UNIT_BY_SUFFIX[suffix];
  if (girth === undefined || unit === undefined) return undefined;
  return { type: girth.type, unit, ...(girth.laterality && { laterality: girth.laterality }) };
}

/**
 * Exact decimal → §4.2 fixed-point (WireNumber) straight from the CSV cell text — lossless,
 * no `Number()` float round-trip. Blank/garbled cells return undefined (csv.ts `num`
 * discipline: no NaN reaches the wire), so the caller skips them silently — an empty cell is
 * absence of data, not a loss. Exotic numeric spellings (e.g. exponential) fall back to a
 * plain JSON number, which is still a valid WireNumber.
 */
function decimal(s: string | undefined): WireNumber | undefined {
  if (s == null) return undefined;
  const t = s.trim();
  if (t === "" || !Number.isFinite(Number(t))) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const dot = t.indexOf(".");
  return dot < 0
    ? { coefficient: Number(t), exponent: 0 }
    : { coefficient: Number(t.replace(".", "")), exponent: dot + 1 - t.length };
}

/** A stable, `#`-free id token for a row's instant (RFC 3339 with punctuation stripped). */
const dateSlug = (instant: string): string => instant.replace(/[^0-9A-Za-z]/g, "");

/**
 * Map a Hevy `measurement_data.csv` export to OpenBody wire records: one point-in-time
 * `Measurement` per non-empty metric cell. Every mapped type is a canonical registry token
 * (`body_mass`/`body_fat_percentage` and the SIDE-AGNOSTIC anthropometry body-circumference
 * set). A limb girth's side is carried on the `laterality` field (§4.1) derived from the
 * column's `left_`/`right_` prefix, not in the type token — see the file header for the full
 * column→(type, laterality) table. Circumference length unit follows the user's Hevy setting
 * via the `_in`/`_cm` column suffix (`[in_i]` vs `cm`); weight is always kg.
 *
 * Input precondition: the header must carry `date` AND at least one recognized metric column
 * — otherwise it is not a Hevy measurement export and this throws {@link MapperInputError}
 * (`mapper: "hevy"`). A blank/unparseable `date` cell degrades that row (warning + skip), and
 * empty metric cells are skipped silently; nothing is ever fabricated.
 *
 * `opts.utcOffset` stamps Hevy's offset-less `"9 Feb 2023, 00:00"`-style `date` (default `"Z"`).
 *
 * Warnings this mapper can emit: `default-subject` (no `opts.subject` given),
 * `unrecognized-column` (once per header column that is neither `date` nor a recognized
 * metric — surfaces Hevy format drift instead of silently dropping it), `unparseable-date`
 * (a row's `date` cell is blank/garbled, so the whole row is skipped).
 */
export function mapHevyMeasurements(csv: string, opts: MapOptions = {}): MapperResult {
  const warnings: MapWarning[] = [];
  const subject = subjectFor(opts, warnings, "hevy");
  const { header, rows } = parseCsvDoc(csv);
  // Structural minimum (WP7): the per-row instant column …
  requireColumns("hevy", header, ["date"]);
  // … and at least one recognized metric column — a `date`-only CSV is not a measurement export.
  const specByCol = new Map<string, MetricSpec>();
  for (const col of header) {
    const spec = specForColumn(col);
    if (spec !== undefined) specByCol.set(col, spec);
  }
  const metricCols = header.filter((c) => specByCol.has(c));
  if (metricCols.length === 0)
    throw new MapperInputError(
      "hevy",
      "input has no recognized measurement column(s) (weight_kg/fat_percent/*_in/*_cm) — not a Hevy measurement CSV",
      "no-measurement-columns",
    );

  // Surface format drift: any column that is neither `date` nor a recognized metric warns
  // once — the lesson from the units bug, where an unrecognized column dropped silently.
  const warnedCols = new Set<string>();
  for (const col of header) {
    if (col === "date" || specByCol.has(col) || warnedCols.has(col)) continue;
    warnedCols.add(col);
    warnings.push({
      code: "unrecognized-column",
      message: `column "${col}" is not a recognized Hevy measurement column — its values are not mapped (possible Hevy format drift)`,
      context: { mapper: "hevy", column: col },
    });
  }

  const prov: Provenance = { method: "manual", sourceApp: "hevy" };
  const records: LiveRecord[] = [];

  for (const row of rows) {
    const rawDate = row.date ?? "";
    const instant = toRfc3339(rawDate, opts.utcOffset);
    // toRfc3339 passes an unrecognized string through unchanged; a valid instant always
    // starts YYYY-MM-DDT… — anything else is a blank/garbled cell we must not put on the wire.
    if (!/^\d{4}-\d{2}-\d{2}T/.test(instant)) {
      warnings.push({
        code: "unparseable-date",
        message: `row has a blank or unparseable date ("${rawDate}") — its measurements are skipped`,
        context: { mapper: "hevy", date: rawDate },
      });
      continue;
    }
    const slug = dateSlug(instant);
    for (const col of metricCols) {
      const value = decimal(row[col]);
      if (value === undefined) continue; // empty cell → no data, skip silently
      const spec = specByCol.get(col);
      if (spec === undefined) continue; // unreachable: col came from specByCol keys
      records.push({
        id: `hevy-meas-${slug}-${col}`,
        recordType: "Measurement",
        subject,
        type: spec.type,
        ...(spec.laterality && { laterality: spec.laterality }),
        quantity: value,
        unit: spec.unit,
        startTime: instant,
        endTime: instant,
        provenance: prov,
      });
    }
  }
  return { records, warnings };
}
