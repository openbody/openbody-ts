// Strong mapper: schema + §8.3 round-trip on the sample export, TZ-independent
// window arithmetic, id stability under re-export (§7.1), and §6.5 resolver wiring.
// Ported from scripts/test-mappers.ts.
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapStrong } from "../../src/mappers/index.js";
import { expectValidAndStable, ofKind, readExample, refObj } from "../helpers.js";

const strongCsv = readExample("strong/strong-sample.csv");

describe("mapStrong", () => {
  it("maps the sample export to valid, round-trip-stable wire records", () => {
    expectValidAndStable(mapStrong(strongCsv).records);
  });

  // Real Strong exports write Duration as human "1h 43m", not bare seconds — verified against
  // a real export (acaylor/python-data-parsing). Must compute endTime, not drop it.
  it("parses a human 'Xh Ym' workout Duration into endTime", () => {
    const csv =
      "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout No\n" +
      "2020-09-15 11:22:57,Chest,1h 43m,Bench Press (Barbell),1,45,5,0,0,,1";
    const [s] = ofKind(mapStrong(csv).records, "Session");
    expect(`${s?.startTime}..${s?.endTime}`).toBe("2020-09-15T11:22:57Z..2020-09-15T13:05:57Z");
  });

  it("maps the wall-clock window timezone-independently", () => {
    const strong = ofKind(mapStrong(strongCsv).records, "Session");
    expect(`${strong[0]?.startTime}..${strong[0]?.endTime}`, "want 18:00Z..19:00Z regardless of host TZ").toBe(
      "2025-12-20T18:00:00Z..2025-12-20T19:00:00Z",
    );
  });

  // Content-derived ids: prepending one more workout to the export must not
  // renumber the session already synced (§7.1 dedup).
  it("keeps ids stable when the export grows", () => {
    const strong = mapStrong(strongCsv).records;
    expect(strong[0]?.clientRecordId).toBeTruthy();
    const [head = "", ...rest] = strongCsv.trim().split("\n");
    const withExtra = [head, "2025-12-19 07:00:00,Leg Day,1800,Squat (Barbell),1,100,5,0,0,,9", ...rest].join("\n");
    const renumbered = mapStrong(withExtra).records;
    expect(renumbered, "expected 2 sessions after prepending a workout").toHaveLength(2);
    const moved = renumbered.find((r) => r.clientRecordId === strong[0]?.clientRecordId);
    expect(moved?.id, "strong id not stable under re-export").toBe(strong[0]?.id);
  });

  // "Bench Press (Barbell)" must land on the same canonical id as Hevy's spelling.
  it("resolves exercise names to canonical ids (cross-app convergence)", () => {
    const refs = ofKind(mapStrong(strongCsv).records, "Session")
      .flatMap((s) => [
        ...(s.exercises ?? []),
        ...ofKind(
          (s.blocks ?? []).flatMap((b) => b.children ?? []),
          "Exercise",
        ),
      ])
      .map((e) => refObj(e.exerciseRef));
    const bench = refs.find((r) => r.opaque === "Bench Press (Barbell)");
    expect(bench?.id).toBe("bench-press.barbell.flat");
  });

  // Regression (RangeError fix, src/errors.ts): a blank/unparseable Date cell must degrade —
  // emit an unparseable-date warning and omit endTime — never throw new Date(NaN).toISOString().
  it("degrades a blank Date row: unparseable-date warning + omitted endTime; valid rows keep endTime", () => {
    const csv = [
      "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout No",
      ",Bad Day,3600,Squat (Barbell),1,100,5,0,0,,1",
      "2025-12-20 18:00:00,Good Day,3600,Bench Press (Barbell),1,80,5,0,0,,2",
    ].join("\n");
    const out = mapStrong(csv, { subject: "me" });
    expect(out.warnings.map((w) => w.code)).toContain("unparseable-date");
    const bad = ofKind(out.records, "Session").find((s) => s.name === "Bad Day");
    expect(bad, "the blank-Date workout is still emitted, just without endTime").toBeDefined();
    expect(bad && "endTime" in bad).toBe(false);
    const good = ofKind(out.records, "Session").find((s) => s.name === "Good Day");
    expect(good?.startTime).toBe("2025-12-20T18:00:00Z");
    expect(good?.endTime, "a valid row still gets start + Duration = end").toBe("2025-12-20T19:00:00Z");
  });

  describe("errors + warnings (WP7 contract)", () => {
    it("empty input throws MapperInputError (no header — not a Strong export)", () => {
      expect(() => mapStrong("")).toThrow(MapperInputError);
    });
    it("header-only CSV maps to an empty result (empty-but-valid export)", () => {
      const out = mapStrong(
        "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout No\n",
      );
      expect(out.records).toEqual([]);
    });
    // WP7: the old raw RangeError (Date arithmetic on "") is now an explicit header check.
    it("a header missing the Date column throws MapperInputError naming the column", () => {
      expect(() => mapStrong("a;b\n1;2")).toThrow(MapperInputError); // also exercises the ';' delimiter sniff
      expect(() => mapStrong("a;b\n1;2")).toThrow(/Date/);
    });
    it("warns default-subject only when opts.subject is absent", () => {
      expect(mapStrong(strongCsv).warnings.map((w) => w.code)).toEqual(["default-subject"]);
      expect(mapStrong(strongCsv, { subject: "me" }).warnings).toEqual([]);
    });
  });
});
