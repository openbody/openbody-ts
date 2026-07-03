// Strava mapper: schema + §8.3 round-trip on the sample, plus the fabrication guards
// (no invented manufacturer, no dangling derivedFrom, clear missing-stream error).
// Ported from scripts/test-mappers.ts.
import { describe, expect, it } from "vitest";
import { mapStrava } from "../../src/mappers/index.js";
import { expectValidAndStable, expectAllValid, readExample } from "../helpers.js";

const sample = () => JSON.parse(readExample("strava/strava-sample.json"));

describe("mapStrava", () => {
  it("maps the sample activity+streams to valid, round-trip-stable wire records", () => {
    expectValidAndStable(mapStrava(sample()));
  });

  // device_name is a free-form display string; the manufacturer is never invented.
  it("never fabricates a device manufacturer from device_name", () => {
    const withHr = mapStrava(sample());
    const dev = withHr.find((r) => r.recordType === "Session")?.provenance?.device;
    expect(dev?.manufacturer).toBeUndefined();
    expect(dev?.model).toBe("Garmin Forerunner 965");
  });

  // Summary HR aggregates derive from the HR stream, but that stream exists only when
  // it was fetched — link it conditionally, never emit a dangling derivedFrom.
  it("emits HR aggregates without dangling derivedFrom when the HR stream is absent", () => {
    const noHrInput = sample();
    delete noHrInput.streams.heartrate;
    const noHr = mapStrava(noHrInput);
    const ids = new Set(noHr.map((r) => r.id));
    for (const r of noHr) {
      for (const l of r.links ?? []) {
        expect(ids.has(l.ref), `dangling ${l.type} → ${l.ref} on ${r.id}`).toBe(true);
      }
    }
    const mean = noHr.find((r) => r.type === "heart_rate_mean");
    expect(
      mean,
      "hr-mean aggregate should still be emitted without the stream (activity summary stands alone)",
    ).toBeDefined();
    expect(mean?.links, "hr-mean must not carry derivedFrom without an HR stream").toBeUndefined();
    expectAllValid(noHr);
  });

  it("errors clearly when the time stream is missing", () => {
    const input = sample();
    expect(() => mapStrava({ activity: input.activity, streams: {} })).toThrow(/streams\.time/);
  });

  describe("malformed input (behavior pinned)", () => {
    it("empty input object throws the clear streams.time error (not a raw TypeError)", () => {
      expect(() => mapStrava({ activity: {}, streams: {} } as any)).toThrow(/streams\.time/);
    });
    it("activity missing its timing fields throws (invalid Date arithmetic)", () => {
      // Current behavior: elapsed_time undefined → NaN epoch → toISOString RangeError.
      expect(() => mapStrava({ activity: {}, streams: { time: { data: [0, 1] } } } as any)).toThrow(RangeError);
    });
  });
});
