// Hevy mapper: schema + §8.3 round-trip on the sample export, timezone-independent
// timestamps + content-derived stable ids (§7.1), and §6.5 resolver wiring.
// Ported from scripts/test-mappers.ts.
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapHevy } from "../../src/mappers/index.js";
import { expectValidAndStable, ofKind, readExample, refObj } from "../helpers.js";

const hevyCsv = readExample("hevy/hevy-sample.csv");

describe("mapHevy", () => {
  it("maps the sample export to valid, round-trip-stable wire records", () => {
    expectValidAndStable(mapHevy(hevyCsv).records);
  });

  // Offset-less CSV wall-clock timestamps must map to the SAME UTC instant on every
  // host TZ (run the suite under different TZ= values to prove it); opts.utcOffset
  // stamps local sources.
  it("maps wall-clock timestamps timezone-independently", () => {
    const hevy = ofKind(mapHevy(hevyCsv).records, "Session");
    expect(hevy[0]?.startTime, "want 2025-12-22T08:00:00Z regardless of host TZ").toBe("2025-12-22T08:00:00Z");
    expect(
      ofKind(mapHevy(hevyCsv, { utcOffset: "-08:00" }).records, "Session")[0]?.startTime,
      "opts.utcOffset not stamped onto the wall-clock time",
    ).toBe("2025-12-22T08:00:00-08:00");
  });

  // Session ids are content-derived — exporting one more workout must not renumber
  // the ones already synced (§7.1 dedup).
  it("derives stable content-hashed ids + clientRecordId", () => {
    const hevy = mapHevy(hevyCsv).records;
    expect(hevy[0]?.id).toMatch(/^hevy-sess-[0-9a-f]{8}$/);
    expect(hevy[0]?.clientRecordId).toBeTruthy();
  });

  // Resolver wiring (OB-65): mapped exercises climb the §6.5 ladder — known names carry
  // a canonical `id` PLUS the lossless original in `opaque`; curated-null names stay
  // opaque-only.
  it("resolves exercise names through the §6.5 ladder (id + lossless opaque)", () => {
    const refs = ofKind(mapHevy(hevyCsv).records, "Session")
      .flatMap((s) => [
        ...(s.exercises ?? []),
        ...ofKind(
          (s.blocks ?? []).flatMap((b) => b.children ?? []),
          "Exercise",
        ),
      ])
      .map((e) => refObj(e.exerciseRef));
    for (const er of refs) {
      expect(er.opaque, `ref ${JSON.stringify(er)} lost the original name (no opaque)`).toBeDefined();
    }
    const expected: Record<string, string | undefined> = {
      "Leg Press (Machine)": "leg-press.machine",
      "Crunch (Weighted)": "crunch.weighted",
      "Seated Shoulder Press (Machine)": "shoulder-press.machine",
      "Pull Up (Assisted)": undefined, // curated null → opaque-only
    };
    for (const [orig, id] of Object.entries(expected)) {
      const er = refs.find((r) => r.opaque === orig);
      expect(er, `no ref with opaque ${orig}`).toBeDefined();
      expect(er?.id, `${orig} resolved to ${er?.id}, expected ${id}`).toBe(id);
    }
  });

  // §5.3 supersets: rows sharing a superset_id group into one grouping:"superset" Block;
  // a standalone row (blank superset_id) is wrapped in its own singleton Block once ANY
  // superset is present (at-most-one container ⇒ everything moves under blocks[]).
  describe("superset grouping (§5.3)", () => {
    const HDR = "title,start_time,end_time,exercise_title,superset_id,set_type,reps,weight_kg";
    const supersetCsv = [
      HDR,
      'W,"22 Dec 2025, 08:00","22 Dec 2025, 09:00",Bench Press (Barbell),1,normal,5,80',
      'W,"22 Dec 2025, 08:00","22 Dec 2025, 09:00",Bent Over Row (Barbell),1,normal,5,60',
      'W,"22 Dec 2025, 08:00","22 Dec 2025, 09:00",Squat (Barbell),,normal,5,100',
    ].join("\n");

    it("a shared superset_id yields a grouping:superset Block with both exercises as children", () => {
      const out = mapHevy(supersetCsv, { subject: "me" });
      expectValidAndStable(out.records);
      const session = ofKind(out.records, "Session")[0];
      expect(session?.exercises, "supersets force everything under blocks[]").toBeUndefined();
      const ss = (session?.blocks ?? []).find((b) => b.grouping === "superset");
      expect(ss?.children).toHaveLength(2);
      expect(ofKind(ss?.children, "Exercise").map((e) => refObj(e.exerciseRef).id)).toEqual([
        "bench-press.barbell.flat",
        "row.barbell.bent-over",
      ]);
    });

    it("a standalone row alongside a superset is wrapped in a singleton (grouping-less) Block", () => {
      const session = ofKind(mapHevy(supersetCsv, { subject: "me" }).records, "Session")[0];
      const standalone = (session?.blocks ?? []).find((b) => b.grouping === undefined);
      expect(standalone?.children).toHaveLength(1);
      expect(refObj(ofKind(standalone?.children, "Exercise")[0]?.exerciseRef).id).toBe("squat.barbell.high-bar");
    });

    // Regression (truthiness fix): with NO superset_id column at all, every row's value is
    // undefined — that must NOT be read as "has a superset" and mint bogus Blocks.
    it("a CSV with no superset_id column produces exercises[], never Blocks", () => {
      const noCol = [
        "title,start_time,end_time,exercise_title,set_type,reps",
        'W,"22 Dec 2025, 08:00","22 Dec 2025, 09:00",Squat (Barbell),normal,5',
      ].join("\n");
      const session = ofKind(mapHevy(noCol, { subject: "me" }).records, "Session")[0];
      expect(session?.blocks, "absent superset_id must not fabricate supersets").toBeUndefined();
      expect(session?.exercises).toHaveLength(1);
    });
  });

  describe("errors + warnings (WP7 contract)", () => {
    it("empty input throws MapperInputError (no header — not a Hevy export)", () => {
      expect(() => mapHevy("")).toThrow(MapperInputError);
    });
    it("header-only CSV maps to an empty result (empty-but-valid export)", () => {
      const out = mapHevy("title,start_time,end_time,exercise_title,superset_id,set_type,reps\n");
      expect(out.records).toEqual([]);
    });
    // WP7: garbage-in-garbage-out is gone — a header without the session-key columns is
    // structurally unusable and throws instead of emitting a fabricated session.
    it("a header missing the expected columns throws MapperInputError naming them", () => {
      expect(() => mapHevy("a,b\n1,2")).toThrow(MapperInputError);
      expect(() => mapHevy("a,b\n1,2")).toThrow(/title, start_time, exercise_title/);
    });
    it("warns default-subject only when opts.subject is absent", () => {
      expect(mapHevy(hevyCsv).warnings.map((w) => w.code)).toEqual(["default-subject"]);
      expect(mapHevy(hevyCsv, { subject: "me" }).warnings).toEqual([]);
    });
  });
});
