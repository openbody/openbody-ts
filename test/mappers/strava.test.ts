// Strava mapper: schema + §8.3 round-trip on the sample, plus the fabrication guards
// (no invented manufacturer, no dangling derivedFrom, clear missing-stream error).
// Ported from scripts/test-mappers.ts.
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapStrava } from "../../src/mappers/index.js";
import { expectAllValid, expectValidAndStable, ofKind, readExample } from "../helpers.js";

const sample = () => JSON.parse(readExample("strava/strava-sample.json"));

describe("mapStrava", () => {
  it("maps the sample activity+streams to valid, round-trip-stable wire records", () => {
    expectValidAndStable(mapStrava(sample()).records);
  });

  it("maps the activity title to Session.name (absent title → no name field)", () => {
    const session = mapStrava(sample()).records.find((r) => r.recordType === "Session");
    expect(session?.name).toBe("Morning Run");
    const untitled = sample();
    delete untitled.activity.name;
    const s2 = mapStrava(untitled).records.find((r) => r.recordType === "Session");
    expect(s2 && "name" in s2, "no fabricated name when the activity has none").toBe(false);
  });

  // device_name is a free-form display string; the manufacturer is never invented.
  it("never fabricates a device manufacturer from device_name", () => {
    const withHr = mapStrava(sample()).records;
    const dev = withHr.find((r) => r.recordType === "Session")?.provenance?.device;
    expect(dev?.manufacturer).toBeUndefined();
    expect(dev?.model).toBe("Garmin Forerunner 965");
  });

  // Summary HR aggregates derive from the HR stream, but that stream exists only when
  // it was fetched — link it conditionally, never emit a dangling derivedFrom.
  it("emits HR aggregates without dangling derivedFrom when the HR stream is absent", () => {
    const noHrInput = sample();
    delete noHrInput.streams.heartrate;
    const noHr = mapStrava(noHrInput).records;
    const ids = new Set(noHr.map((r) => r.id));
    for (const r of noHr) {
      for (const l of r.links ?? []) {
        expect(ids.has(l.ref), `dangling ${l.type} → ${l.ref} on ${r.id}`).toBe(true);
      }
    }
    const mean = ofKind(noHr, "Measurement").find((r) => r.type === "heart_rate_mean");
    expect(
      mean,
      "hr-mean aggregate should still be emitted without the stream (activity summary stands alone)",
    ).toBeDefined();
    expect(mean?.links, "hr-mean must not carry derivedFrom without an HR stream").toBeUndefined();
    expectAllValid(noHr);
  });

  // Regression (§4.3 null-pad contract): the location route null-pads a short altitude
  // stream (pushes null, never undefined) and survives a null latlng fix; summary metrics
  // are omitted (not NaN) when the activity lacks them.
  it("null-pads a short altitude stream and a null latlng fix; omits absent distance/time", () => {
    const input = {
      activity: { id: 42, start_date: "2026-01-01T00:00:00Z", elapsed_time: 20, sport_type: "Run" },
      streams: {
        time: { data: [0, 10, 20] },
        latlng: { data: [[1, 2], null, [5, 6]] },
        altitude: { data: [100, 110] },
      },
    };
    const out = mapStrava(input, { subject: "me" }).records;
    expectAllValid(out);
    const route = ofKind(out, "Measurement").find((r) => r.type === "location");
    expect(route?.sampleArray?.dataPoints).toEqual([
      [1, 2, 100],
      [null, null, 110], // null latlng → [null, null, alt]
      [5, 6, null], // altitude stream ran out → padded null, NOT undefined
    ]);
    const thirdAlt = (route?.sampleArray?.dataPoints?.[2] as (number | null)[])[2];
    expect(thirdAlt, "short altitude stream must pad null, not undefined").toBeNull();
    const wu = ofKind(out, "Session")[0]?.workUnits?.[0];
    expect(wu?.performance?.distance, "absent distance omitted, never NaN").toBeUndefined();
    expect(wu?.performance?.time, "absent moving_time omitted, never NaN").toBeUndefined();
  });

  it("throws MapperInputError (clear message) when the time stream is missing", () => {
    const input = sample();
    expect(() => mapStrava({ activity: input.activity, streams: {} })).toThrow(MapperInputError);
    expect(() => mapStrava({ activity: input.activity, streams: {} })).toThrow(/streams\.time/);
  });

  describe("errors + warnings (WP7 contract)", () => {
    it("empty input object throws the clear streams.time MapperInputError (not a raw TypeError)", () => {
      expect(() => mapStrava({ activity: {}, streams: {} })).toThrow(/streams\.time/);
    });
    it("activity missing its timing fields throws MapperInputError naming the field (was a RangeError)", () => {
      expect(() => mapStrava({ activity: {}, streams: { time: { data: [0, 1] } } })).toThrow(MapperInputError);
      expect(() => mapStrava({ activity: {}, streams: { time: { data: [0, 1] } } })).toThrow(/start_date/);
      const noElapsed = sample();
      delete noElapsed.activity.elapsed_time;
      expect(() => mapStrava(noElapsed)).toThrow(/elapsed_time/);
    });
    it("warns default-subject only when opts.subject is absent", () => {
      expect(mapStrava(sample()).warnings.map((w) => w.code)).toEqual(["default-subject"]);
      expect(mapStrava(sample(), { subject: "me" }).warnings).toEqual([]);
    });
  });
});
