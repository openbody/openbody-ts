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
