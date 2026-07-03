// FIT mapper: schema + §8.3 round-trip on both decoded-file kinds (recorded activity
// and structured workout definition). Ported from scripts/test-mappers.ts.
import { describe, expect, it } from "vitest";
import { mapFit } from "../../src/mappers/index.js";
import { expectValidAndStable, readExample } from "../helpers.js";

describe("mapFit", () => {
  it("maps the decoded activity sample to valid, round-trip-stable wire records", () => {
    expectValidAndStable(mapFit(JSON.parse(readExample("fit/fit-activity-sample.json"))));
  });

  it("maps the decoded workout sample to valid, round-trip-stable wire records", () => {
    expectValidAndStable(mapFit(JSON.parse(readExample("fit/fit-workout-sample.json"))));
  });

  it("wraps repeat_until_ steps into a repetitions Block (workout sample)", () => {
    const [session] = mapFit(JSON.parse(readExample("fit/fit-workout-sample.json")));
    expect(session?.recordType).toBe("Session");
    const repeatBlock = (session?.blocks ?? []).find((b: any) => b.repetitions !== undefined);
    expect(repeatBlock, "expected a repeat block from the repeat_until_ step").toBeDefined();
    expect((repeatBlock?.children ?? []).length).toBeGreaterThan(0);
  });

  describe("malformed input (behavior pinned)", () => {
    it("an empty decode still emits one bare (undated) Session", () => {
      const out = mapFit({});
      expect(out).toHaveLength(1);
      expect(out[0]?.recordType).toBe("Session");
      expect(out[0]?.startTime).toBeUndefined();
    });
    it("a workouts-only decode emits a planned Session with no blocks content", () => {
      const out = mapFit({ workouts: [{ wkt_name: "Empty" }] });
      expect(out).toHaveLength(1);
      expect(out[0]?.name).toBe("Empty");
      expect(out[0]?.blocks).toEqual([]);
    });
  });
});
