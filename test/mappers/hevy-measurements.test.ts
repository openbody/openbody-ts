// Hevy measurement_data.csv mapper tests: body-metric CSV → point-in-time Pillar-A
// Measurements. Covers the standard bar (schema-validate + round-trip), the canonical
// body_mass/body_fat_percentage tokens, the SIDE-AGNOSTIC anthropometry circumference tokens
// with the side carried on the `laterality` field (§4.1), the UNITS behaviour (an inches
// export → `[in_i]` vs a centimetres export → `cm`, while weight stays kg regardless), empty
// cells producing no records, the unrecognized-column drift warning, and the WP7
// error/warnings contract. Mirrors concept2.test.ts / fitbit.test.ts structure.
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapHevyMeasurements } from "../../src/mappers/hevy-measurements.js";
import { expectValidAndStable, ofKind, readExample } from "../helpers.js";

// The founder's real export uses inch (`_in`) circumference columns.
const inCsv = readExample("hevy/hevy-measurements-sample.csv");
const out = mapHevyMeasurements(inCsv, { subject: "me" });
const measurements = ofKind(out.records, "Measurement");
const byType = (t: string) => measurements.filter((r) => r.type === t);

// A second real user's export uses centimetre (`_cm`) circumference columns.
const cmCsv = readExample("hevy/hevy-measurements-cm-sample.csv");
const cmOut = mapHevyMeasurements(cmCsv, { subject: "me" });
const cmMeas = ofKind(cmOut.records, "Measurement");
const cmByType = (t: string) => cmMeas.filter((r) => r.type === t);

describe("mapHevyMeasurements", () => {
  it("maps the measurement sample to valid, round-trip-stable wire records", () => {
    expectValidAndStable(out.records);
    expectValidAndStable(cmOut.records);
  });

  // weight_kg → canonical body_mass in kg, exact §4.2 fixed-point (70.5 → 705e-1), point-in-time.
  it("maps weight_kg to a canonical body_mass Measurement in kg (exact decimal)", () => {
    const w = byType("body_mass");
    expect(w, "expected exactly one body_mass record").toHaveLength(1);
    expect(w[0]?.quantity).toEqual({ coefficient: 705, exponent: -1 });
    expect(w[0]?.unit).toBe("kg");
    expect(w[0]?.provenance).toEqual({ method: "manual", sourceApp: "hevy" });
    // Point-in-time: startTime == endTime == the parsed instant (offset-less date, stamped Z).
    expect(w[0]?.startTime).toBe("2024-01-03T07:30:00Z");
    expect(w[0]?.endTime).toBe("2024-01-03T07:30:00Z");
  });

  // fat_percent → canonical body_fat_percentage in %.
  it("maps fat_percent to a canonical body_fat_percentage Measurement in %", () => {
    const f = byType("body_fat_percentage");
    expect(f, "expected exactly one body_fat_percentage record").toHaveLength(1);
    expect(f[0]?.quantity).toEqual({ coefficient: 182, exponent: -1 });
    expect(f[0]?.unit).toBe("%");
  });

  // INCHES export: circumference columns are `_in` → SIDE-AGNOSTIC anthropometry tokens in
  // `[in_i]`. A both-sides row → two `bicep_circumference` Measurements distinguished by the
  // `laterality` FIELD (§4.1), not by the type token, with distinct exact values.
  it("maps `_in` circumferences to side-agnostic tokens in [in_i], side on the laterality field", () => {
    const biceps = byType("bicep_circumference");
    expect(biceps, "both bicep sides share the side-agnostic type").toHaveLength(2);
    const left = biceps.filter((r) => r.laterality === "left");
    const right = biceps.filter((r) => r.laterality === "right");
    expect(left, "left bicep").toHaveLength(1);
    expect(right, "right bicep").toHaveLength(1);
    expect(left[0]?.unit).toBe("[in_i]");
    expect(right[0]?.unit).toBe("[in_i]");
    expect(left[0]?.quantity).toEqual({ coefficient: 145, exponent: -1 });
    expect(right[0]?.quantity).toEqual({ coefficient: 1475, exponent: -2 });
    expect(left[0]?.startTime).toBe("2024-01-07T08:00:00Z");
    expect(left[0]?.id).not.toContain("#");
    // Non-lateral stem → NO laterality field; `hips` → `hip_circumference`; `neck` → `neck_circumference`.
    const neck = byType("neck_circumference")[0];
    expect(neck?.unit).toBe("[in_i]");
    expect(neck?.laterality).toBeUndefined();
    expect(neck?.quantity).toEqual({ coefficient: 155, exponent: -1 });
  });

  // CENTIMETRES export (the bug fix): the SAME canonical tokens, but unit `cm` from the `_cm`
  // suffix — these used to match nothing and be silently dropped.
  it("maps `_cm` circumferences to the SAME canonical tokens but in cm", () => {
    const neck = cmByType("neck_circumference");
    expect(neck, "neck circumference").toHaveLength(1);
    expect(neck[0]?.unit).toBe("cm");
    expect(neck[0]?.laterality).toBeUndefined();
    expect(neck[0]?.quantity).toEqual({ coefficient: 385, exponent: -1 });
    const biceps = cmByType("bicep_circumference");
    const left = biceps.filter((r) => r.laterality === "left");
    const right = biceps.filter((r) => r.laterality === "right");
    expect(left[0]?.unit).toBe("cm");
    expect(right[0]?.unit).toBe("cm");
    expect(left[0]?.quantity).toEqual({ coefficient: 372, exponent: -1 });
    expect(right[0]?.quantity).toEqual({ coefficient: 378, exponent: -1 });
  });

  // weight is ALWAYS kg regardless of the circumference unit system.
  it("keeps weight in kg even in a centimetres export", () => {
    const w = cmByType("body_mass");
    expect(w, "expected one body_mass record").toHaveLength(1);
    expect(w[0]?.unit).toBe("kg");
    expect(w[0]?.quantity).toEqual({ coefficient: 823, exponent: -1 });
    expect(cmByType("body_fat_percentage")[0]?.unit).toBe("%");
  });

  // One Measurement per NON-EMPTY cell only: the all-empty-except-date row yields nothing, and
  // no record carries the 2024-01-09 instant.
  it("produces no records for an all-empty-except-date row", () => {
    expect(measurements.some((r) => r.startTime === "2024-01-09T08:00:00Z")).toBe(false);
    // 1 weight + 1 fat + 2 bicep + 1 neck = 5 non-empty cells across the sample.
    expect(measurements).toHaveLength(5);
    expect(cmMeas).toHaveLength(5); // 1 weight + 1 fat + 1 neck + 2 bicep
  });

  describe("errors + warnings (WP7 contract)", () => {
    // Every mapped type is canonical now, so a clean export emits NO warnings when a subject
    // is provided (no unrecognized columns, no default-subject).
    it("a clean run with a subject emits no warnings; without a subject only default-subject", () => {
      expect(out.warnings).toEqual([]);
      expect(cmOut.warnings).toEqual([]);
      const noSubject = mapHevyMeasurements(inCsv);
      expect(noSubject.warnings.map((w) => w.code)).toEqual(["default-subject"]);
    });

    // Format-drift guard: a header column that is neither `date` nor a recognized metric
    // surfaces as `unrecognized-column`, once, instead of being silently dropped.
    it("fires unrecognized-column once per unknown header column (surfaces format drift)", () => {
      const drift = mapHevyMeasurements(
        'date,weight_kg,bodyfat_ratio\n"3 Jan 2024, 07:30",70.5,0.18\n"5 Jan 2024, 07:30",71,0.17\n',
        { subject: "me" },
      );
      const unrec = drift.warnings.filter((w) => w.code === "unrecognized-column");
      expect(unrec).toHaveLength(1);
      expect(unrec[0]?.context?.column).toBe("bodyfat_ratio");
      // The recognized weight column still maps; the unknown one contributes no records.
      expect(ofKind(drift.records, "Measurement").every((r) => r.type === "body_mass")).toBe(true);
    });

    // A circumference stem we don't know (or a new unit spelling) also surfaces, not drops.
    it("treats an unknown circumference stem/unit as an unrecognized column", () => {
      const drift = mapHevyMeasurements('date,weight_kg,wingspan_in,neck_m\n"3 Jan 2024, 07:30",70.5,72,40\n', {
        subject: "me",
      });
      const cols = drift.warnings
        .filter((w) => w.code === "unrecognized-column")
        .map((w) => w.context?.column)
        .sort();
      expect(cols).toEqual(["neck_m", "wingspan_in"]);
    });

    it("degrades a blank-date row with an unparseable-date warning + skips it", () => {
      const bad = mapHevyMeasurements('date,weight_kg\n,70.5\n"5 Jan 2024, 07:30",71\n', { subject: "me" });
      expect(bad.warnings.map((w) => w.code)).toContain("unparseable-date");
      expect(ofKind(bad.records, "Measurement")).toHaveLength(1);
      expect(ofKind(bad.records, "Measurement")[0]?.startTime).toBe("2024-01-05T07:30:00Z");
    });

    it("empty input throws MapperInputError (no header — not a Hevy export)", () => {
      expect(() => mapHevyMeasurements("")).toThrow(MapperInputError);
    });

    it("a header missing the date column throws MapperInputError naming the column", () => {
      expect(() => mapHevyMeasurements("weight_kg\n70.5")).toThrow(/date/);
    });

    it("a date-only CSV (no recognized metric column) throws MapperInputError", () => {
      expect(() => mapHevyMeasurements('date\n"3 Jan 2024, 07:30"')).toThrow(MapperInputError);
    });

    it("a header-only measurement CSV maps to an empty result", () => {
      const empty = mapHevyMeasurements("date,weight_kg\n", { subject: "me" });
      expect(empty.records).toEqual([]);
    });
  });

  // Dogfood guard (OB-56): a trimmed slice of a REAL Hevy export, whose shape the synthetic
  // fixtures above don't exercise — the header row is FULLY QUOTED (`"date","weight_kg",…`, vs
  // the unquoted fixture headers), most rows are SPARSE (only weight_kg logged; circumferences
  // never filled), single-digit days ("9 Feb"), and some values are bare INTEGERS ("83", "20")
  // whose §4.2 fixed-point is exponent 0. One Measurement per non-empty metric cell, nothing
  // dropped, everything schema-valid — the invariants the "156 measurements" real run relies on.
  describe("real export shape (OB-56 dogfood)", () => {
    const realCsv = readExample("hevy/hevy-measurements-real-sample.csv");
    const realOut = mapHevyMeasurements(realCsv, { subject: "me" });
    const realMeas = ofKind(realOut.records, "Measurement");

    it("parses the quoted header + maps every non-empty metric cell with no data loss", () => {
      // 4 weight cells + 2 fat cells across 4 sparse rows = 6 Measurements, nothing else.
      expect(realMeas).toHaveLength(6);
      expect(realMeas.filter((r) => r.type === "body_mass")).toHaveLength(4);
      expect(realMeas.filter((r) => r.type === "body_fat_percentage")).toHaveLength(2);
      // Weight-only rows contribute exactly their weight — no fabricated circumference records.
      expect(realMeas.every((r) => r.type === "body_mass" || r.type === "body_fat_percentage")).toBe(true);
      // Clean export + explicit subject → no warnings at all (no drift, no default-subject).
      expect(realOut.warnings).toEqual([]);
    });

    it("encodes bare-integer cell values as exact exponent-0 fixed-point", () => {
      // Row "26 Feb 2023" logs weight "83" (integer) → {83, 0}, kg.
      const intWeight = realMeas.find((r) => r.startTime === "2023-02-26T00:00:00Z" && r.type === "body_mass");
      expect(intWeight?.quantity).toEqual({ coefficient: 83, exponent: 0 });
      expect(intWeight?.unit).toBe("kg");
      // Row "5 Dec 2024" logs fat "20" (integer) → {20, 0}, %.
      const intFat = realMeas.find((r) => r.type === "body_fat_percentage" && r.startTime === "2024-12-05T00:00:00Z");
      expect(intFat?.quantity).toEqual({ coefficient: 20, exponent: 0 });
      expect(intFat?.unit).toBe("%");
    });

    it("maps the real shape to valid, round-trip-stable wire records", () => {
      expectValidAndStable(realOut.records);
    });
  });
});
