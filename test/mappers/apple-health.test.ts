// Apple Health mapper: schema + §8.3 round-trip on the sample export.xml, plus the
// WP1 regression: HR records link (measuredBy) only to the workout whose window
// encloses them. Ported from scripts/test-mappers.ts.
import { describe, expect, it } from "vitest";
import { mapAppleHealth } from "../../src/mappers/index.js";
import { expectValidAndStable, readExample } from "../helpers.js";

const xml = readExample("apple-health/export-sample.xml");

describe("mapAppleHealth", () => {
  it("maps the sample export.xml to valid, round-trip-stable wire records", () => {
    const records = mapAppleHealth(xml);
    expectValidAndStable(records);
  });

  it("links HR measurements only to the enclosing workout window (§7.2)", () => {
    const records = mapAppleHealth(xml);
    const sessions = records.filter((r) => r.recordType === "Session");
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) {
      const ws = Date.parse(s.startTime),
        we = Date.parse(s.endTime);
      const refs = (s.workUnits?.[0]?.links ?? []).filter((l: any) => l.type === "measuredBy").map((l: any) => l.ref);
      for (const ref of refs) {
        const m = records.find((r) => r.id === ref);
        expect(m, `dangling measuredBy → ${ref}`).toBeDefined();
        expect(
          Date.parse(m?.startTime) >= ws && Date.parse(m?.endTime) <= we,
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
    expect(out[0]?.provenance?.device?.model).toBe("Tom & Jerry’s Watch");
  });

  describe("malformed input (behavior pinned)", () => {
    it("empty input maps to []", () => {
      expect(mapAppleHealth("")).toEqual([]);
    });
    it("XML without Record/Workout elements maps to []", () => {
      expect(mapAppleHealth('<HealthData><ExportDate value="x"/></HealthData>')).toEqual([]);
    });
  });
});
