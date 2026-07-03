// Apple Health mapper: schema + §8.3 round-trip on the sample export.xml, plus the
// WP1 regression: HR records link (measuredBy) only to the workout whose window
// encloses them. Ported from scripts/test-mappers.ts.
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapAppleHealth } from "../../src/mappers/index.js";
import { expectValidAndStable, ofKind, readExample } from "../helpers.js";

const xml = readExample("apple-health/export-sample.xml");

describe("mapAppleHealth", () => {
  it("maps the sample export.xml to valid, round-trip-stable wire records", () => {
    const { records } = mapAppleHealth(xml);
    expectValidAndStable(records);
  });

  it("links HR measurements only to the enclosing workout window (§7.2)", () => {
    const { records } = mapAppleHealth(xml);
    const sessions = records.filter((r) => r.recordType === "Session");
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) {
      const ws = Date.parse(s.startTime ?? ""),
        we = Date.parse(s.endTime ?? "");
      const refs = (s.workUnits?.[0]?.links ?? []).filter((l) => l.type === "measuredBy").map((l) => l.ref);
      for (const ref of refs) {
        const m = ofKind(records, "Measurement").find((r) => r.id === ref);
        expect(m, `dangling measuredBy → ${ref}`).toBeDefined();
        expect(
          Date.parse(m?.startTime ?? "") >= ws && Date.parse(m?.endTime ?? "") <= we,
          `${ref} window outside workout ${s.id}`,
        ).toBe(true);
      }
    }
  });

  // Reviewer C8: entity-encoded attribute values must decode ("Tom &amp; Jerry" ≠ literal).
  it("decodes XML entities in attribute values (sourceName → provenance.device.model)", () => {
    const out = mapAppleHealth(
      `<HealthData><Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Tom &amp; Jerry&#8217;s Watch"
        unit="count/min" startDate="2026-06-20 06:30:00 +0000" endDate="2026-06-20 06:30:00 +0000" value="72"/></HealthData>`,
    );
    expect(out.records[0]?.provenance?.device?.model).toBe("Tom & Jerry’s Watch");
  });

  describe("errors + warnings (WP7 contract)", () => {
    it("input without a <HealthData> root throws MapperInputError", () => {
      expect(() => mapAppleHealth("")).toThrow(MapperInputError);
      expect(() => mapAppleHealth("not xml at all")).toThrow(/HealthData/);
    });
    it("a valid export without Record/Workout elements maps to an empty result", () => {
      const out = mapAppleHealth('<HealthData><ExportDate value="x"/></HealthData>');
      expect(out.records).toEqual([]);
    });
    it("Records missing required attrs degrade to a skip + warning (never a throw)", () => {
      const out = mapAppleHealth(
        `<HealthData>
          <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2026-06-20 06:30:00 +0000" endDate="2026-06-20 06:30:00 +0000"/>
          <Workout workoutActivityType="HKWorkoutActivityTypeRunning"/>
        </HealthData>`,
      );
      expect(out.records).toEqual([]);
      const skipped = out.warnings.filter((w) => w.code === "skipped-record");
      expect(skipped).toHaveLength(2);
      expect(skipped[0]?.context?.missing).toEqual(["value"]);
      expect(skipped[1]?.context?.missing).toEqual(["startDate", "endDate"]);
    });
    it("Record types with no encoding are dropped with one aggregated warning", () => {
      const out = mapAppleHealth(
        `<HealthData>
          <Record type="HKCategoryTypeIdentifierMindfulSession" startDate="2026-06-20 06:30:00 +0000" endDate="2026-06-20 06:40:00 +0000" value="x"/>
          <Record type="HKCategoryTypeIdentifierMindfulSession" startDate="2026-06-21 06:30:00 +0000" endDate="2026-06-21 06:40:00 +0000" value="x"/>
        </HealthData>`,
      );
      expect(out.records).toEqual([]);
      const w = out.warnings.find((x) => x.code === "unmapped-record-types");
      expect(w).toBeDefined();
      expect(w?.context?.counts).toEqual({ HKCategoryTypeIdentifierMindfulSession: 2 });
    });
    it("warns default-subject when opts.subject is absent, and not when it is passed", () => {
      expect(mapAppleHealth(xml).warnings.some((w) => w.code === "default-subject")).toBe(true);
      expect(mapAppleHealth(xml, { subject: "me" }).warnings.some((w) => w.code === "default-subject")).toBe(false);
    });
  });
});
