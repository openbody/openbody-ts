// Hevy measurement_data.csv mapper tests: body-metric CSV → point-in-time Pillar-A
// Measurements. Covers the standard bar (schema-validate + round-trip), the canonical
// body_mass/body_fat_percentage tokens, a left/right circumference pair with laterality in
// the token, empty cells producing no records, the namespaced-fallback warning, and the
// WP7 error/warnings contract. Mirrors concept2.test.ts / fitbit.test.ts structure.
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapHevyMeasurements } from "../../src/mappers/hevy-measurements.js";
import { expectValidAndStable, ofKind, readExample } from "../helpers.js";

const csv = readExample("hevy/hevy-measurements-sample.csv");
const out = mapHevyMeasurements(csv, { subject: "me" });
const measurements = ofKind(out.records, "Measurement");
const byType = (t: string) => measurements.filter((r) => r.type === t);

describe("mapHevyMeasurements", () => {
  it("maps the measurement sample to valid, round-trip-stable wire records", () => {
    expectValidAndStable(out.records);
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

  // A both-sides circumference row → two Measurements whose left/right laterality lives in the
  // token (schema/registry have no laterality field), same unit [in_i], distinct exact values.
  it("emits a left/right circumference pair with laterality encoded in the token", () => {
    const left = byType("hevy:circumference_bicep_left");
    const right = byType("hevy:circumference_bicep_right");
    expect(left, "left bicep").toHaveLength(1);
    expect(right, "right bicep").toHaveLength(1);
    expect(left[0]?.unit).toBe("[in_i]");
    expect(right[0]?.unit).toBe("[in_i]");
    expect(left[0]?.quantity).toEqual({ coefficient: 145, exponent: -1 });
    expect(right[0]?.quantity).toEqual({ coefficient: 1475, exponent: -2 });
    expect(left[0]?.startTime).toBe("2024-01-07T08:00:00Z");
    expect(left[0]?.id).not.toContain("#");
  });

  // One Measurement per NON-EMPTY cell only: the all-empty-except-date row yields nothing, and
  // no record carries the 2024-01-09 instant.
  it("produces no records for an all-empty-except-date row", () => {
    expect(measurements.some((r) => r.startTime === "2024-01-09T08:00:00Z")).toBe(false);
    // 1 weight + 1 fat + 2 bicep + 1 neck = 5 non-empty cells across the sample.
    expect(measurements).toHaveLength(5);
  });

  describe("errors + warnings (WP7 contract)", () => {
    // Each distinct circumference column with no canonical registry token warns exactly once.
    it("fires unmapped-measurement-type once per distinct namespaced circumference column", () => {
      const unmapped = out.warnings.filter((w) => w.code === "unmapped-measurement-type");
      const cols = unmapped.map((w) => w.context?.column).sort();
      // bicep_left, bicep_right, neck are the three circumference columns with data in the sample.
      expect(cols).toEqual(["left_bicep_in", "neck_in", "right_bicep_in"]);
      expect(unmapped.every((w) => String(w.context?.type).startsWith("hevy:circumference_"))).toBe(true);
    });

    it("a clean run emits only default-subject; passing a subject emits nothing extra", () => {
      // With a subject provided the only warnings are the namespaced-type notices (no default-subject).
      expect(out.warnings.some((w) => w.code === "default-subject")).toBe(false);
      const noSubject = mapHevyMeasurements(csv);
      expect(noSubject.warnings.filter((w) => w.code === "default-subject")).toHaveLength(1);
      // A weight-only CSV maps cleanly with no namespaced columns → only default-subject.
      const clean = mapHevyMeasurements('date,weight_kg\n"3 Jan 2024, 07:30",70.5\n');
      expect(clean.warnings.map((w) => w.code)).toEqual(["default-subject"]);
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
});
