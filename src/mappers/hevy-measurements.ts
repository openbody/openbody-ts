// Hevy `measurement_data.csv` export → OpenBody Pillar-A Measurement records (the body
// metrics Hevy logs alongside workouts; separate from the workout export mapped by
// mapHevy in ./hevy.ts). One Measurement per NON-EMPTY metric cell per row; each is a
// point-in-time observation (startTime == endTime == that instant).
//
// Input shape (real export header, verified against a founder's own `measurement_data.csv`):
//   date,weight_kg,fat_percent,neck_in,shoulder_in,chest_in,left_bicep_in,right_bicep_in,
//   left_forearm_in,right_forearm_in,abdomen_in,waist_in,hips_in,left_thigh_in,
//   right_thigh_in,left_calf_in,right_calf_in
// `date` is Hevy's offset-less local wall-clock "9 Feb 2023, 00:00"; most cells on a given
// row are blank (only the metrics recorded that day are filled). Circumference columns are
// international inches (UCUM `[in_i]`).
//
// Measurement.type token choices (§4.4/§5.9 open-token ladder), checked against the sibling
// registry (openbody-registry vocab/measurements/body-composition.json):
//   - weight_kg   → `body_mass` (canonical), unit `kg`.
//   - fat_percent → `body_fat_percentage` (canonical), unit `%`.
//   - every *_in circumference column → a `hevy:`-namespaced fallback token: the registry's
//     body-composition subset has NO circumference vocabulary at all (only body_mass,
//     body_fat_percentage, lean_body_mass, bmi), so no canonical token exists to use. Each
//     distinct unmapped column raises a one-time `unmapped-measurement-type` MapWarning (a
//     registry-gap signal). Because Measurement.type is an OPEN token, these still
//     schema-validate and round-trip; the namespacing is about honest semantic quality.
//
// LATERALITY: the Measurement schema has NO laterality/side field, and the registry has no
// laterality token set, so left/right is encoded losslessly IN THE TOKEN as a `_left`/
// `_right` suffix (e.g. `hevy:circumference_bicep_left`). Non-lateral circumferences carry
// no suffix (`hevy:circumference_waist`). This keeps every side a distinct, self-describing
// type — consistent and reversible — rather than silently collapsing the two sides.
//
// `opts.utcOffset` stamps the offset-less `date` (default "Z"), consistent with the other
// CSV mappers. Numbers are kept as exact §4.2 fixed-point straight from the cell text
// (fitbit.ts `fixed` discipline) — no float round-trip. Provenance is manual/hevy (these
// are hand-logged body metrics).
import { MapperInputError } from "../errors.js";
import type { LiveRecord, MapOptions, MapperResult, MapWarning, Provenance, WireNumber } from "../types.js";
import { parseCsvDoc, requireColumns, toRfc3339 } from "./csv.js";
import { subjectFor } from "./shared.js";

/** How one CSV metric column maps onto a Measurement. `canonical` marks a registry-backed type. */
interface MetricSpec {
  type: string;
  unit: string;
  canonical: boolean;
}

// A circumference column → its `hevy:`-namespaced fallback token (registry has none) in `[in_i]`.
const circ = (token: string): MetricSpec => ({ type: `hevy:circumference_${token}`, unit: "[in_i]", canonical: false });

// Column → Measurement mapping. Key order is the emission order within a row.
const METRICS: Record<string, MetricSpec> = {
  weight_kg: { type: "body_mass", unit: "kg", canonical: true },
  fat_percent: { type: "body_fat_percentage", unit: "%", canonical: true },
  neck_in: circ("neck"),
  shoulder_in: circ("shoulder"),
  chest_in: circ("chest"),
  left_bicep_in: circ("bicep_left"),
  right_bicep_in: circ("bicep_right"),
  left_forearm_in: circ("forearm_left"),
  right_forearm_in: circ("forearm_right"),
  abdomen_in: circ("abdomen"),
  waist_in: circ("waist"),
  hips_in: circ("hips"),
  left_thigh_in: circ("thigh_left"),
  right_thigh_in: circ("thigh_right"),
  left_calf_in: circ("calf_left"),
  right_calf_in: circ("calf_right"),
};

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
 * `Measurement` per non-empty metric cell (`body_mass`/`body_fat_percentage` canonical, every
 * body-circumference column a `hevy:`-namespaced fallback with `_left`/`_right` laterality in
 * the token — see the file header for the full type table and the laterality decision).
 *
 * Input precondition: the header must carry `date` AND at least one recognized metric column
 * — otherwise it is not a Hevy measurement export and this throws {@link MapperInputError}
 * (`mapper: "hevy"`). A blank/unparseable `date` cell degrades that row (warning + skip), and
 * empty metric cells are skipped silently; nothing is ever fabricated.
 *
 * `opts.utcOffset` stamps Hevy's offset-less `"9 Feb 2023, 00:00"`-style `date` (default `"Z"`).
 *
 * Warnings this mapper can emit: `default-subject` (no `opts.subject` given),
 * `unmapped-measurement-type` (once per distinct circumference column with no canonical
 * registry token — the type is namespaced under `hevy:` instead), `unparseable-date` (a
 * row's `date` cell is blank/garbled, so the whole row is skipped).
 */
export function mapHevyMeasurements(csv: string, opts: MapOptions = {}): MapperResult {
  const warnings: MapWarning[] = [];
  const subject = subjectFor(opts, warnings, "hevy");
  const { header, rows } = parseCsvDoc(csv);
  // Structural minimum (WP7): the per-row instant column …
  requireColumns("hevy", header, ["date"]);
  // … and at least one recognized metric column — a `date`-only CSV is not a measurement export.
  const metricCols = Object.keys(METRICS).filter((c) => header.includes(c));
  if (metricCols.length === 0)
    throw new MapperInputError(
      "hevy",
      "input has no recognized measurement column(s) (weight_kg/fat_percent/*_in) — not a Hevy measurement CSV",
      "no-measurement-columns",
    );

  const prov: Provenance = { method: "manual", sourceApp: "hevy" };
  const records: LiveRecord[] = [];
  const warnedCols = new Set<string>();

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
      const spec = METRICS[col];
      if (spec === undefined) continue; // unreachable: col came from METRICS keys
      if (!spec.canonical && !warnedCols.has(col)) {
        warnedCols.add(col);
        warnings.push({
          code: "unmapped-measurement-type",
          message: `column "${col}" has no canonical registry measurement type — mapped to namespaced "${spec.type}"`,
          context: { mapper: "hevy", column: col, type: spec.type },
        });
      }
      records.push({
        id: `hevy-meas-${slug}-${col}`,
        recordType: "Measurement",
        subject,
        type: spec.type,
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
