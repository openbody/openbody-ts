// FIT mapper: schema + §8.3 round-trip on both decoded-file kinds (recorded activity
// and structured workout definition). Ported from scripts/test-mappers.ts.
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapFit } from "../../src/mappers/index.js";
import { abs, expectValidAndStable, ofKind, readExample } from "../helpers.js";

describe("mapFit", () => {
  it("maps the decoded activity sample to valid, round-trip-stable wire records", () => {
    expectValidAndStable(mapFit(JSON.parse(readExample("fit/fit-activity-sample.json"))).records);
  });

  it("maps the decoded workout sample to valid, round-trip-stable wire records", () => {
    expectValidAndStable(mapFit(JSON.parse(readExample("fit/fit-workout-sample.json"))).records);
  });

  it("wraps repeat_until_ steps into a repetitions Block (workout sample)", () => {
    const [session] = ofKind(mapFit(JSON.parse(readExample("fit/fit-workout-sample.json"))).records, "Session");
    expect(session?.recordType).toBe("Session");
    const repeatBlock = ofKind(session?.blocks, "Block").find((b) => b.repetitions !== undefined);
    expect(repeatBlock, "expected a repeat block from the repeat_until_ step").toBeDefined();
    expect((repeatBlock?.children ?? []).length).toBeGreaterThan(0);
  });

  // OB-83: hardening against DOCUMENTED non-Garmin quirks. Fixtures are SYNTHETIC
  // reproductions of each defect's SHAPE (see each fixture's _comment) — they are NOT
  // real device exports, and real-file verification (COROS + Suunto + Zwift) is the
  // remaining acceptance step tracked on the ticket.
  describe("non-Garmin device quirks (SYNTHETIC fixtures)", () => {
    it("COROS field-size violation: array/{value}-wrapped scalars normalize (python-fitparse#116)", () => {
      const { records } = mapFit(JSON.parse(readExample("fit/fit-coros-oversized-field.json")), { subject: "me" });
      expectValidAndStable(records);
      const hr = ofKind(records, "Measurement").find((m) => m.type === "heart_rate");
      // The oversized-field wrapping ([138] / {value:156}) must be flattened to scalars,
      // not leak arrays into a single-channel stream's dataPoints.
      expect(hr?.sampleArray?.dataPoints).toEqual([138, 149, 156]);
      const [session] = ofKind(records, "Session");
      const wu = session?.workUnits?.[0];
      expect(abs(wu?.performance?.distance)?.value).toBe(800); // total_distance was [800, 255]
      expect(abs(wu?.performance?.energy)?.value).toBe(62); // total_calories was { value: 62 }
    });

    it("Suunto lap-structure defect: ALL laps are captured, not just the first", () => {
      const { records } = mapFit(JSON.parse(readExample("fit/fit-suunto-multilap.json")), { subject: "me" });
      expectValidAndStable(records);
      const [session] = ofKind(records, "Session");
      const wus = session?.workUnits ?? [];
      expect(wus.map((w) => w.id)).toEqual(["fit-lap-wu-0", "fit-lap-wu-1", "fit-lap-wu-2", "fit-lap-wu-3"]);
      expect(wus.map((w) => abs(w.performance?.distance)?.value)).toEqual([1000, 1000, 1000, 1000]);
    });

    it("Polar sparse FIT: missing optional fields degrade gracefully, no crash", () => {
      const { records } = mapFit(JSON.parse(readExample("fit/fit-polar-sparse.json")), { subject: "me" });
      expectValidAndStable(records);
      const measurements = ofKind(records, "Measurement");
      // Only heart_rate was carried — no route / power / cadence streams should be emitted.
      expect(measurements.map((m) => m.type)).toEqual(["heart_rate"]);
      const wu = ofKind(records, "Session")[0]?.workUnits?.[0];
      expect(abs(wu?.performance?.time)?.value).toBe(180);
      expect(wu?.performance?.distance).toBeUndefined();
      expect(wu?.performance?.energy).toBeUndefined();
    });
  });

  describe("errors + warnings (WP7 contract)", () => {
    // WP7: an empty decode used to fabricate one bare Session — it now throws.
    it("a decode with none of the FIT message lists throws MapperInputError", () => {
      expect(() => mapFit({})).toThrow(MapperInputError);
      expect(() => mapFit({})).toThrow(/sessions\/laps\/records\/workouts\/workout_steps/);
    });
    it("a workouts-only decode emits a planned Session with no blocks content", () => {
      const out = ofKind(mapFit({ workouts: [{ wkt_name: "Empty" }] }).records, "Session");
      expect(out).toHaveLength(1);
      expect(out[0]?.name).toBe("Empty");
      expect(out[0]?.blocks).toEqual([]);
    });
    it("warns when extra sessions / extra workouts are dropped (laps are now captured, not dropped)", () => {
      const activity = JSON.parse(readExample("fit/fit-activity-sample.json"));
      const twoSessions = {
        ...activity,
        sessions: [...(activity.sessions ?? []), ...(activity.sessions ?? [])],
        laps: [{ timestamp: "2026-01-01T00:10:00Z" }],
      };
      const codes = mapFit(twoSessions).warnings.map((w) => w.code);
      expect(codes).toContain("extra-sessions-dropped");
      // OB-83: per-lap splits are mapped into WorkUnits now — no longer dropped-with-a-warning.
      expect(codes).not.toContain("laps-dropped");
      const twoWorkouts = mapFit({ workouts: [{ wkt_name: "A" }, { wkt_name: "B" }] });
      expect(twoWorkouts.warnings.map((w) => w.code)).toContain("extra-workouts-dropped");
    });
    it("warns default-subject only when opts.subject is absent", () => {
      const activity = JSON.parse(readExample("fit/fit-activity-sample.json"));
      expect(mapFit(activity).warnings.map((w) => w.code)).toContain("default-subject");
      expect(mapFit(activity, { subject: "me" }).warnings.map((w) => w.code)).not.toContain("default-subject");
    });
  });
});
