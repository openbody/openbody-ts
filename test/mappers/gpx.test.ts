// GPX mapper tests (OB-79): map the schema-built samples → wire records,
// schema-validate every record, assert offsets/channel shapes, HR values,
// measuredBy links, and the degenerate cases (untimed, waypoint-only).
// Ported from scripts/test-tcx-gpx.ts.
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapGpx } from "../../src/mappers/gpx.js";
import { expectAllValid, expectRoundTripStable, ofKind, readExample } from "../helpers.js";

describe("mapGpx", () => {
  describe("timed two-segment track with TrackPointExtension hr/cad", () => {
    const gpx = mapGpx(readExample("gpx/gpx-sample.gpx")).records;

    it("every record validates + normalization round-trips", () => {
      expectAllValid(gpx);
      expectRoundTripStable(gpx);
      expect(
        gpx,
        `expected 4 records (route, hr, cadence, session), got ${gpx.map((r) => r.id).join(",")}`,
      ).toHaveLength(4);
    });

    it("concatenates trksegs into one honest offset series (the pause stays visible)", () => {
      const route = ofKind(gpx, "Measurement").find((r) => r.id === "gpx-route");
      // 18:37:26 +0/5/8, then segment 2 at +98/+103
      expect(route?.sampleArray?.offsets).toEqual([0, 5, 8, 98, 103]);
      expect(route?.sampleArray?.channels?.map((c) => c.name)).toEqual(["lat", "lon", "alt"]);
      expect(route?.unit, "multi-channel route must not carry a top-level unit").toBeUndefined();
      expect(route?.sampleArray?.dataPoints?.[3]).toEqual([47.6448, -122.3265, 7.1]);
      const p4 = route?.sampleArray?.dataPoints?.[4];
      expect(Array.isArray(p4) ? p4[2] : p4, "point without <ele> must have null alt").toBeNull();
      expect(route?.startTime).toBe("2009-10-17T18:37:26Z");
      expect(route?.endTime).toBe("2009-10-17T18:39:09Z");
    });

    it("extracts TrackPointExtension streams sharing the location offsets", () => {
      const hr = ofKind(gpx, "Measurement").find((r) => r.id === "gpx-hr");
      expect(hr?.sampleArray?.dataPoints).toEqual([128, 132, 135, 121, 124]);
      expect(hr?.type).toBe("heart_rate");
      expect(hr?.unit).toBe("/min");
      expect(hr?.sampleArray?.offsets, "hr must share the location offsets").toEqual([0, 5, 8, 98, 103]);
      const cad = ofKind(gpx, "Measurement").find((r) => r.id === "gpx-cadence");
      expect(cad?.sampleArray?.dataPoints).toEqual([84, 86, 87, 82, null]);
    });

    it("builds the Session (discipline, name, links, workUnit, creator residue)", () => {
      const session = gpx.find((r) => r.recordType === "Session");
      expect(session?.disciplines).toEqual(["running"]);
      expect(session?.name).toBe("Example GPX Document");
      const refs = (session?.links ?? []).filter((l) => l.type === "measuredBy").map((l) => l.ref);
      expect(refs).toEqual(["gpx-route", "gpx-hr", "gpx-cadence"]);
      const wu = session?.workUnits?.[0];
      expect(wu?.scoring).toBe("continuous");
      expect(wu?.performance?.time).toEqual({ absolute: { value: 103, unit: "s" } });
      expect(session?.extension?.gpx?.creator, "creator not preserved").toBe("RunKeeper");
    });
  });

  describe("degenerate: track without <time> — no offsets representable", () => {
    const untimed = mapGpx(readExample("gpx/gpx-no-time-sample.gpx")).records;

    it("emits 1 Session only, geometry preserved in extension.gpx.untimedTrack", () => {
      expectAllValid(untimed);
      expectRoundTripStable(untimed);
      expect(untimed).toHaveLength(1);
      const s = ofKind(untimed, "Session")[0];
      expect(s?.recordType).toBe("Session");
      expect(s?.startTime, "untimed session must not fabricate start/end times").toBeUndefined();
      expect(s?.endTime).toBeUndefined();
      expect(s?.disciplines).toEqual(["hiking"]);
      const track = s?.extension?.gpx?.untimedTrack as { points?: (number | null)[][] } | undefined;
      expect(track?.points).toHaveLength(3);
      expect(track?.points?.[0]).toEqual([46.5784, 8.00654, 1932]);
    });
  });

  it("waypoint-only (GPX 1.0) maps to an empty result + a no-mappable-content warning", () => {
    const out = mapGpx(readExample("gpx/gpx-waypoints-sample.gpx"));
    expect(out.records).toEqual([]);
    expect(out.warnings.some((w) => w.code === "no-mappable-content")).toBe(true);
  });

  // Reviewer C8: regex-XML parsing must still decode the five XML entities (+ numeric
  // character references) — a track named "Tom &amp; Jerry" must not stay encoded.
  it("decodes XML entities in extracted text (track name → Session.name)", () => {
    const xml = `<gpx creator="Caf&#233; &quot;Runner&quot;"><trk><name>Tom &amp; Jerry &lt;3 &#x1F44D;</name><type>running</type>
      <trkseg><trkpt lat="1" lon="2"><time>2026-01-01T00:00:00Z</time></trkpt></trkseg></trk></gpx>`;
    const out = mapGpx(xml).records;
    const session = out.find((r) => r.recordType === "Session");
    expect(session?.name).toBe("Tom & Jerry <3 \u{1F44D}");
    expect(session?.extension?.gpx?.creator, "attribute values decode too").toBe('Café "Runner"');
  });

  // Regression (xml.ts fix): XML 1.0 permits single-quoted attributes — lat='47.6' must
  // parse identically to lat="47.6", not yield NaN lat/lon.
  it("parses single-quoted lat/lon attributes (not just double-quoted)", () => {
    const xml =
      "<gpx creator='RunKeeper'><trk><trkseg>" +
      "<trkpt lat='47.6' lon='-122.3'><time>2026-01-01T00:00:00Z</time></trkpt>" +
      "<trkpt lat='47.7' lon='-122.4'><time>2026-01-01T00:00:05Z</time></trkpt>" +
      "</trkseg></trk></gpx>";
    const out = mapGpx(xml, { subject: "me" }).records;
    expectAllValid(out);
    const route = ofKind(out, "Measurement").find((r) => r.id === "gpx-route");
    expect(route?.sampleArray?.dataPoints).toEqual([
      [47.6, -122.3, null],
      [47.7, -122.4, null],
    ]);
    expect(out.find((r) => r.recordType === "Session")?.extension?.gpx?.creator).toBe("RunKeeper");
  });

  describe("errors + warnings (WP7 contract)", () => {
    it("input without a <gpx> root throws MapperInputError", () => {
      expect(() => mapGpx("")).toThrow(MapperInputError);
      expect(() => mapGpx("not xml at all")).toThrow(/<gpx>/);
    });
    it("untimed tracks warn untimed-track; mixed tracks warn dropped-untimed-points", () => {
      const untimed = mapGpx(readExample("gpx/gpx-no-time-sample.gpx"));
      expect(untimed.warnings.some((w) => w.code === "untimed-track")).toBe(true);
      const mixed = mapGpx(`<gpx><trk><trkseg>
        <trkpt lat="1" lon="2"><time>2026-01-01T00:00:00Z</time></trkpt>
        <trkpt lat="1" lon="2.1"/>
      </trkseg></trk></gpx>`);
      const w = mixed.warnings.find((x) => x.code === "dropped-untimed-points");
      expect(w?.context).toEqual({ dropped: 1, total: 2 });
      const session = mixed.records.find((r) => r.recordType === "Session");
      expect(session?.extension?.gpx?.droppedUntimedPoints).toBe(1);
    });
    it("warns default-subject only when opts.subject is absent", () => {
      const fixture = readExample("gpx/gpx-sample.gpx");
      expect(mapGpx(fixture).warnings.some((w) => w.code === "default-subject")).toBe(true);
      expect(mapGpx(fixture, { subject: "me" }).warnings.some((w) => w.code === "default-subject")).toBe(false);
    });
  });
});
