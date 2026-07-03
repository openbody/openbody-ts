// FIT mapper: schema + §8.3 round-trip on both decoded-file kinds (recorded activity
// and structured workout definition). Ported from scripts/test-mappers.ts.
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapFit } from "../../src/mappers/index.js";
import { expectValidAndStable, ofKind, readExample } from "../helpers.js";

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
    it("warns when lap messages / extra sessions / extra workouts are dropped", () => {
      const activity = JSON.parse(readExample("fit/fit-activity-sample.json"));
      const twoSessions = {
        ...activity,
        sessions: [...(activity.sessions ?? []), ...(activity.sessions ?? [])],
        laps: [{ timestamp: "2026-01-01T00:10:00Z" }],
      };
      const codes = mapFit(twoSessions).warnings.map((w) => w.code);
      expect(codes).toContain("extra-sessions-dropped");
      expect(codes).toContain("laps-dropped");
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
