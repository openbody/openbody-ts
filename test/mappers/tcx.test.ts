// TCX mapper tests (OB-79): lap→WorkUnit mapping, trackpoint streams, lap HR
// aggregates with derivedFrom links, and the Activities-less degenerate case.
// Ported from scripts/test-tcx-gpx.ts.
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapTcx } from "../../src/mappers/tcx.js";
import { expectAllValid, expectRoundTripStable, ofKind, readExample } from "../helpers.js";

describe("mapTcx", () => {
  describe("one Running activity, 2 laps, streams + lap aggregates", () => {
    const tcx = mapTcx(readExample("tcx/tcx-sample.tcx")).records;

    it("every record validates + normalization round-trips", () => {
      expectAllValid(tcx);
      expectRoundTripStable(tcx);
      expect(
        tcx,
        `expected 9 records (route/hr/cadence/power + 4 aggregates + session), got ${tcx.map((r) => r.id).join(",")}`,
      ).toHaveLength(9);
    });

    it("builds the Session (id, clientRecordId, discipline, span, Creator device)", () => {
      const session = tcx.find((r) => r.recordType === "Session");
      expect(session?.id).toBe("tcx-1");
      expect(session?.clientRecordId).toBe("2010-06-26T10:06:11Z");
      expect(session?.disciplines).toEqual(["running"]);
      expect(session?.startTime).toBe("2010-06-26T10:06:11Z");
      expect(session?.endTime).toBe("2010-06-26T10:06:41Z");
      expect(session?.provenance?.device?.model).toBe("Garmin Forerunner 305");
    });

    // Lap → WorkUnit mapping (§5.1 collapsed hierarchy: Session.workUnits, no invented Block tier).
    it("maps laps to Session.workUnits", () => {
      const session = tcx.find((r) => r.recordType === "Session");
      const wus = session?.workUnits ?? [];
      expect(wus).toHaveLength(2);
      const lap1 = wus[0];
      expect(lap1?.scoring).toBe("continuous");
      expect(lap1?.startTime).toBe("2010-06-26T10:06:11Z");
      expect(lap1?.performance?.time).toEqual({ absolute: { value: 15, unit: "s" } });
      expect(lap1?.performance?.distance).toEqual({ absolute: { value: 50, unit: "m" } });
      expect(lap1?.performance?.energy).toEqual({ absolute: { value: 4, unit: "kcal" } });
      expect(lap1?.setRole, "Active lap must not carry a setRole").toBeUndefined();
      expect(wus[1]?.setRole).toBe("tcx:resting");
    });

    it("extracts trackpoint streams (offsets across laps, GPS dropout nulls, ns3:Watts)", () => {
      const wantOffsets = [0, 5, 10, 15, 20, 30]; // laps concatenated (incl. the 10 s gap)
      const hr = ofKind(tcx, "Measurement").find((r) => r.id === "tcx-1-hr");
      expect(hr?.sampleArray?.offsets).toEqual(wantOffsets);
      expect(hr?.sampleArray?.dataPoints).toEqual([128, 133, 138, 145, 150, 148]);
      const route = ofKind(tcx, "Measurement").find((r) => r.id === "tcx-1-route");
      expect(route?.sampleArray?.channels?.map((c) => c.name)).toEqual(["lat", "lon", "alt"]);
      expect(route?.sampleArray?.dataPoints?.[4], "GPS-dropout point must null lat/lon").toEqual([null, null, 4.1]);
      const watts = ofKind(tcx, "Measurement").find((r) => r.id === "tcx-1-power");
      expect(watts?.sampleArray?.dataPoints).toEqual([245, 252, 258, 260, null, 241]);
      const session = tcx.find((r) => r.recordType === "Session");
      const refs = (session?.links ?? []).filter((l) => l.type === "measuredBy").map((l) => l.ref);
      expect(refs).toEqual(["tcx-1-route", "tcx-1-hr", "tcx-1-cadence", "tcx-1-power"]);
    });

    // Lap Average/MaximumHeartRateBpm → interval aggregates with derivedFrom → the HR stream.
    it("emits lap HR aggregates with derivedFrom links and a named algorithm (§7.4)", () => {
      const mean1 = ofKind(tcx, "Measurement").find((r) => r.id === "tcx-1-lap-1-hr-mean");
      expect(mean1?.quantity).toBe(133);
      expect(mean1?.type).toBe("heart_rate_mean");
      expect(mean1?.startTime).toBe("2010-06-26T10:06:11Z");
      expect(mean1?.endTime).toBe("2010-06-26T10:06:26Z");
      expect(
        mean1?.links?.some((l) => l.type === "derivedFrom" && l.ref === "tcx-1-hr"),
        "lap aggregate missing derivedFrom → hr stream",
      ).toBe(true);
      expect(mean1?.provenance?.algorithm?.name, "derived aggregate should name its algorithm (§7.4)").toBeDefined();
      const max2 = ofKind(tcx, "Measurement").find((r) => r.id === "tcx-1-lap-2-hr-max");
      expect(max2?.quantity).toBe(150);
    });
  });

  it("Courses-only file maps to an empty result + a no-mappable-content warning", () => {
    const coursesOnly = `<?xml version="1.0"?>
      <TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
        <Courses><Course><Name>Loop</Name>
          <Lap><TotalTimeSeconds>600</TotalTimeSeconds><DistanceMeters>2000</DistanceMeters>
            <BeginPosition><LatitudeDegrees>52.1</LatitudeDegrees><LongitudeDegrees>4.4</LongitudeDegrees></BeginPosition>
            <EndPosition><LatitudeDegrees>52.2</LatitudeDegrees><LongitudeDegrees>4.5</LongitudeDegrees></EndPosition>
            <Intensity>Active</Intensity>
          </Lap>
        </Course></Courses>
      </TrainingCenterDatabase>`;
    const out = mapTcx(coursesOnly);
    expect(out.records).toEqual([]);
    expect(out.warnings.some((w) => w.code === "no-mappable-content")).toBe(true);
  });

  // Reviewer C8: entity-encoded source text must decode ("Tom &amp; Jerry" ≠ literal).
  it("decodes XML entities in extracted text (Creator Name → provenance.device.model)", () => {
    const out = mapTcx(
      `<TrainingCenterDatabase><Activities><Activity Sport="Running"><Id>tom &amp; jerry &lt;run&gt;</Id>
        <Creator><Name>Bob&#39;s &quot;Watch&quot;</Name></Creator></Activity></Activities></TrainingCenterDatabase>`,
    ).records;
    expect(out[0]?.clientRecordId).toBe("tom & jerry <run>");
    expect(out[0]?.provenance?.device?.model).toBe(`Bob's "Watch"`);
  });

  describe("errors + warnings (WP7 contract)", () => {
    it("input without a <TrainingCenterDatabase> root throws MapperInputError", () => {
      expect(() => mapTcx("")).toThrow(MapperInputError);
      expect(() => mapTcx("not xml at all")).toThrow(/TrainingCenterDatabase/);
    });
    it("an Activity with no laps/trackpoints still emits an undated Session", () => {
      const out = mapTcx(
        '<TrainingCenterDatabase><Activities><Activity Sport="Running"><Id>run-1</Id></Activity></Activities></TrainingCenterDatabase>',
      ).records;
      expect(out).toHaveLength(1);
      expect(out[0]?.recordType).toBe("Session");
      expect(out[0]?.clientRecordId).toBe("run-1");
    });
    it("untimed trackpoints are dropped with a warning", () => {
      const out = mapTcx(
        `<TrainingCenterDatabase><Activities><Activity Sport="Running"><Id>run-1</Id>
          <Lap StartTime="2026-01-01T00:00:00Z"><TotalTimeSeconds>10</TotalTimeSeconds><Track>
            <Trackpoint><Time>2026-01-01T00:00:00Z</Time><HeartRateBpm><Value>120</Value></HeartRateBpm></Trackpoint>
            <Trackpoint><HeartRateBpm><Value>121</Value></HeartRateBpm></Trackpoint>
          </Track></Lap></Activity></Activities></TrainingCenterDatabase>`,
      );
      const w = out.warnings.find((x) => x.code === "dropped-untimed-points");
      expect(w?.context).toEqual({ activity: "tcx-1", dropped: 1, total: 2 });
    });
    it("warns default-subject only when opts.subject is absent", () => {
      const fixture = readExample("tcx/tcx-sample.tcx");
      expect(mapTcx(fixture).warnings.map((w) => w.code)).toEqual(["default-subject"]);
      expect(mapTcx(fixture, { subject: "me" }).warnings).toEqual([]);
    });
  });
});
