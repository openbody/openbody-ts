// Concept2 Logbook mapper tests (OB-81): piece-scoring inference, interval Block
// expansion with rest, HR measurement linking, machine-type mapping, TZ-independent
// windows, and registry-backed exerciseRef ids. Ported from
// scripts/test-concept2-thecrag.ts.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapConcept2 } from "../../src/mappers/concept2.js";
import {
  abs,
  collectExerciseRefIds,
  expectValidAndStable,
  haveRegistry,
  ofKind,
  readExample,
  refObj,
  registryExercisesPath,
} from "../helpers.js";

const c2 = mapConcept2(readExample("concept2/concept2-season-sample.csv")).records;
const sess = (name: string) => ofKind(c2, "Session").find((r) => r.name === name);

describe("mapConcept2", () => {
  it("maps the season sample to valid, round-trip-stable wire records", () => {
    expectValidAndStable(c2);
  });

  // Fixed-distance piece: distance-scored; elapsed time preserved as residue; stroke
  // rate + watts as achieved intensity (§5.13); avg HR as measuredBy-linked Measurement.
  it("fixed-distance piece (2000m row)", () => {
    const twoK = sess("2000m row");
    const wu = twoK?.workUnits?.[0];
    expect(wu?.scoring).toBe("distance");
    expect(abs(wu?.performance?.distance)?.value).toBe(2000);
    expect(wu?.performance?.time, "distance-scored unit must not carry a time metric (§5.5)").toBeUndefined();
    expect(twoK?.extension?.concept2?.workTimeSeconds).toBe(465.3);
    const cad = wu?.performance?.intensity?.find((x) => x.dimension === "cadence");
    expect(abs(cad?.value)?.value).toBe(28);
    expect(cad?.unit).toBe("/min");
    const pow = wu?.performance?.intensity?.find((x) => x.dimension === "power");
    expect(abs(pow?.value)?.value).toBe(221);
    expect(refObj(wu?.exerciseRef).id).toBe("row.erg");
    expect(twoK?.disciplines).toEqual(["rowing"]);
    const hr = ofKind(c2, "Measurement").find((r) => r.id === `${twoK?.id}-hr`);
    expect(hr?.type).toBe("heart_rate_mean");
    expect(hr?.quantity).toBe(172);
    expect(hr?.unit).toBe("/min");
    expect(
      twoK?.links?.some((l) => l.type === "measuredBy" && l.ref === hr?.id),
      "Session missing measuredBy link to the HR measurement",
    ).toBe(true);
    // The Date column is offset-less wall-clock time — the mapped instant (and the HR
    // measurement window) must be the same on every host TZ (parsed manually, stamped "Z").
    expect(twoK?.startTime, "want 06:45:00Z regardless of host TZ").toBe("2026-03-02T06:45:00Z");
    expect(twoK?.endTime).toBe("2026-03-02T06:52:45Z");
    expect(hr?.startTime, "HR window not TZ-independent").toBe("2026-03-02T06:45:00Z");
  });

  // Fixed-time piece on the SkiErg: time-scored; skierg discipline namespaced; ski.erg id.
  it("fixed-time piece (30:00 SkiErg)", () => {
    const thirty = sess("30:00 SkiErg");
    const wu = thirty?.workUnits?.[0];
    expect(wu?.scoring).toBe("time");
    expect(abs(wu?.performance?.time)?.value).toBe(1800);
    expect(refObj(wu?.exerciseRef).id).toBe("ski.erg");
    expect(thirty?.disciplines).toEqual(["concept2:skierg"]);
  });

  // "Just row": continuous, carries time + distance + energy; no HR column ⇒ no Measurement.
  it("just-row piece (2:37 row) degrades to continuous", () => {
    const jr = sess("2:37 row");
    const wu = jr?.workUnits?.[0];
    expect(wu?.scoring).toBe("continuous");
    expect(abs(wu?.performance?.time)?.value).toBe(157.4);
    expect(abs(wu?.performance?.distance)?.value).toBe(610);
    expect(
      c2.some((r) => r.recordType === "Measurement" && r.id === `${jr?.id}-hr`),
      "HR measurement emitted with no Avg Heart Rate",
    ).toBe(false);
  });

  // 8x500m/0:30r ⇒ Block of 8 distance-scored 500 m WorkUnits, each with 30 s rest.
  it("fixed intervals (8x500m/0:30r) expand to a Block with per-interval rest", () => {
    const iv = sess("8x500m/0:30r row");
    expect(iv?.blocks).toHaveLength(1);
    const kids = iv?.blocks?.[0]?.children ?? [];
    expect(kids).toHaveLength(8);
    expect(ofKind(kids, "WorkUnit"), "every child is a WorkUnit").toHaveLength(8);
    for (const k of ofKind(kids, "WorkUnit")) {
      expect(k.scoring).toBe("distance");
      expect(abs(k.performance?.distance)?.value).toBe(500);
      expect(abs(k.performance?.rest)?.value).toBe(30);
      expect(refObj(k.exerciseRef).id).toBe("row.erg");
    }
    expect(iv?.extension?.concept2?.avgStrokeRate, "whole-workout stroke rate should be residue").toBe(30);
  });

  // 4x5:00/1:00r ⇒ 4 time-scored 300 s children with 60 s rest.
  it("fixed time intervals (4x5:00/1:00r)", () => {
    const tv = sess("4x5:00/1:00r row");
    const kids = ofKind(tv?.blocks?.[0]?.children, "WorkUnit");
    expect(kids).toHaveLength(4);
    expect(kids[0]?.scoring).toBe("time");
    expect(abs(kids[0]?.performance?.time)?.value).toBe(300);
    expect(abs(kids[3]?.performance?.rest)?.value).toBe(60);
  });

  // Variable intervals: the season CSV only discloses the first interval + count, so it
  // degrades to a single continuous WorkUnit with the rest totals as residue.
  it("variable intervals degrade to a single continuous unit (no fabricated Block)", () => {
    const vv = sess("v2000m/3:00r...3 BikeErg");
    expect(vv?.blocks, "must not fabricate a per-interval Block from the season CSV").toBeUndefined();
    const wu = vv?.workUnits?.[0];
    expect(wu?.scoring).toBe("continuous");
    expect(abs(wu?.performance?.distance)?.value).toBe(6000);
    expect(vv?.extension?.concept2?.restTimeSeconds).toBe(540);
    expect(vv?.disciplines).toEqual(["cycling"]);
    // BikeErg has no canonical registry id — opaque-only.
    expect(refObj(wu?.exerciseRef).id).toBeUndefined();
    expect(refObj(wu?.exerciseRef).opaque).toBe("BikeErg");
  });

  // Every canonical exerciseRef id the mapper emits exists in the registry
  // (../openbody-registry/data/exercises.json, override with OPENBODY_REGISTRY).
  it.skipIf(!haveRegistry)("every canonical exerciseRef id exists in the registry", () => {
    const known = new Set(
      (JSON.parse(fs.readFileSync(registryExercisesPath, "utf8")) as { id: string }[]).map((e) => e.id),
    );
    const ids = collectExerciseRefIds(c2);
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) expect(known.has(id), `exerciseRef id "${id}" not in the registry`).toBe(true);
  });

  describe("errors + warnings (WP7 contract)", () => {
    it("empty input throws MapperInputError (no header — not a Concept2 export)", () => {
      expect(() => mapConcept2("")).toThrow(MapperInputError);
    });
    // WP7: the old raw RangeError (Date arithmetic on "") is now an explicit header check.
    it("a header missing the Date column throws MapperInputError naming the column", () => {
      expect(() => mapConcept2("a,b\n1,2")).toThrow(MapperInputError);
      expect(() => mapConcept2("a,b\n1,2")).toThrow(/Date/);
    });
    it("header-only CSV maps to an empty result (empty-but-valid export)", () => {
      const out = mapConcept2('"Log ID",Date,Description,Type\n');
      expect(out.records).toEqual([]);
    });
    it("warns default-subject only when opts.subject is absent", () => {
      const csv = readExample("concept2/concept2-season-sample.csv");
      expect(mapConcept2(csv).warnings.map((w) => w.code)).toEqual(["default-subject"]);
      expect(mapConcept2(csv, { subject: "me" }).warnings).toEqual([]);
    });

    // Regression (RangeError fix, src/errors.ts): a blank/unparseable Date cell must degrade —
    // unparseable-date warning + omitted endTime — never throw new Date(NaN).toISOString().
    it("degrades a blank Date row: unparseable-date warning + omitted endTime; valid rows keep endTime", () => {
      const csv = [
        '"Log ID",Date,Description,"Work Distance","Work Time (Seconds)",Type',
        "1,,2000m row,2000,465.3,RowErg",
        "2,2026-03-02 06:45:00,2000m row,2000,465.3,RowErg",
      ].join("\n");
      const out = mapConcept2(csv, { subject: "me" });
      expect(out.warnings.map((w) => w.code)).toContain("unparseable-date");
      const bad = ofKind(out.records, "Session").find((s) => s.clientRecordId === "1");
      expect(bad && "endTime" in bad, "blank-Date row omits endTime").toBe(false);
      const good = ofKind(out.records, "Session").find((s) => s.clientRecordId === "2");
      expect(good?.startTime).toBe("2026-03-02T06:45:00Z");
      expect(good?.endTime, "start + work+rest = end (465.3s ≈ 7:45)").toBe("2026-03-02T06:52:45Z");
    });
  });
});
