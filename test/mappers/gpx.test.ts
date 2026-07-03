// GPX mapper tests (OB-79): map the schema-built samples → wire records,
// schema-validate every record, assert offsets/channel shapes, HR values,
// measuredBy links, and the degenerate cases (untimed, waypoint-only).
// Ported from scripts/test-tcx-gpx.ts.
import { describe, expect, it } from "vitest";
import { mapGpx } from "../../src/mappers/gpx.js";
import { expectAllValid, expectRoundTripStable, readExample } from "../helpers.js";

describe("mapGpx", () => {
  describe("timed two-segment track with TrackPointExtension hr/cad", () => {
    const gpx = mapGpx(readExample("gpx/gpx-sample.gpx"));

    it("every record validates + normalization round-trips", () => {
      expectAllValid(gpx);
      expectRoundTripStable(gpx);
      expect(
        gpx,
        `expected 4 records (route, hr, cadence, session), got ${gpx.map((r) => r.id).join(",")}`,
      ).toHaveLength(4);
    });

    it("concatenates trksegs into one honest offset series (the pause stays visible)", () => {
      const route = gpx.find((r) => r.id === "gpx-route");
      // 18:37:26 +0/5/8, then segment 2 at +98/+103
      expect(route?.sampleArray?.offsets).toEqual([0, 5, 8, 98, 103]);
      expect(route?.sampleArray?.channels?.map((c: any) => c.name)).toEqual(["lat", "lon", "alt"]);
      expect(route?.unit, "multi-channel route must not carry a top-level unit").toBeUndefined();
      expect(route?.sampleArray?.dataPoints?.[3]).toEqual([47.6448, -122.3265, 7.1]);
      expect(route?.sampleArray?.dataPoints?.[4]?.[2], "point without <ele> must have null alt").toBeNull();
      expect(route?.startTime).toBe("2009-10-17T18:37:26Z");
      expect(route?.endTime).toBe("2009-10-17T18:39:09Z");
    });

    it("extracts TrackPointExtension streams sharing the location offsets", () => {
      const hr = gpx.find((r) => r.id === "gpx-hr");
      expect(hr?.sampleArray?.dataPoints).toEqual([128, 132, 135, 121, 124]);
      expect(hr?.type).toBe("heart_rate");
      expect(hr?.unit).toBe("/min");
      expect(hr?.sampleArray?.offsets, "hr must share the location offsets").toEqual([0, 5, 8, 98, 103]);
      const cad = gpx.find((r) => r.id === "gpx-cadence");
      expect(cad?.sampleArray?.dataPoints).toEqual([84, 86, 87, 82, null]);
    });

    it("builds the Session (discipline, name, links, workUnit, creator residue)", () => {
      const session = gpx.find((r) => r.recordType === "Session");
      expect(session?.disciplines).toEqual(["running"]);
      expect(session?.name).toBe("Example GPX Document");
      const refs = (session?.links ?? []).filter((l: any) => l.type === "measuredBy").map((l: any) => l.ref);
      expect(refs).toEqual(["gpx-route", "gpx-hr", "gpx-cadence"]);
      const wu = session?.workUnits?.[0];
      expect(wu?.scoring).toBe("continuous");
      expect(wu?.performance?.time).toEqual({ absolute: { value: 103, unit: "s" } });
      expect(session?.extension?.gpx?.creator, "creator not preserved").toBe("RunKeeper");
    });
  });

  describe("degenerate: track without <time> — no offsets representable", () => {
    const untimed = mapGpx(readExample("gpx/gpx-no-time-sample.gpx"));

    it("emits 1 Session only, geometry preserved in extension.gpx.untimedTrack", () => {
      expectAllValid(untimed);
      expectRoundTripStable(untimed);
      expect(untimed).toHaveLength(1);
      const s = untimed[0];
      expect(s?.recordType).toBe("Session");
      expect(s?.startTime, "untimed session must not fabricate start/end times").toBeUndefined();
      expect(s?.endTime).toBeUndefined();
      expect(s?.disciplines).toEqual(["hiking"]);
      const track = s?.extension?.gpx?.untimedTrack;
      expect(track?.points).toHaveLength(3);
      expect(track?.points?.[0]).toEqual([46.5784, 8.00654, 1932]);
    });
  });

  it("waypoint-only (GPX 1.0) maps to [] gracefully (waypoints are map annotations, not telemetry)", () => {
    expect(mapGpx(readExample("gpx/gpx-waypoints-sample.gpx"))).toEqual([]);
  });

  describe("malformed input (behavior pinned)", () => {
    it("empty input maps to []", () => {
      expect(mapGpx("")).toEqual([]);
    });
    it("non-XML garbage maps to []", () => {
      expect(mapGpx("not xml at all")).toEqual([]);
    });
  });
});
