// Hevy mapper: schema + §8.3 round-trip on the sample export, timezone-independent
// timestamps + content-derived stable ids (§7.1), and §6.5 resolver wiring.
// Ported from scripts/test-mappers.ts.
import { describe, expect, it } from "vitest";
import { mapHevy } from "../../src/mappers/index.js";
import { expectValidAndStable, ofKind, readExample, refObj } from "../helpers.js";

const hevyCsv = readExample("hevy/hevy-sample.csv");

describe("mapHevy", () => {
  it("maps the sample export to valid, round-trip-stable wire records", () => {
    expectValidAndStable(mapHevy(hevyCsv));
  });

  // Offset-less CSV wall-clock timestamps must map to the SAME UTC instant on every
  // host TZ (run the suite under different TZ= values to prove it); opts.utcOffset
  // stamps local sources.
  it("maps wall-clock timestamps timezone-independently", () => {
    const hevy = ofKind(mapHevy(hevyCsv), "Session");
    expect(hevy[0]?.startTime, "want 2025-12-22T08:00:00Z regardless of host TZ").toBe("2025-12-22T08:00:00Z");
    expect(
      ofKind(mapHevy(hevyCsv, { utcOffset: "-08:00" }), "Session")[0]?.startTime,
      "opts.utcOffset not stamped onto the wall-clock time",
    ).toBe("2025-12-22T08:00:00-08:00");
  });

  // Session ids are content-derived — exporting one more workout must not renumber
  // the ones already synced (§7.1 dedup).
  it("derives stable content-hashed ids + clientRecordId", () => {
    const hevy = mapHevy(hevyCsv);
    expect(hevy[0]?.id).toMatch(/^hevy-sess-[0-9a-f]{8}$/);
    expect(hevy[0]?.clientRecordId).toBeTruthy();
  });

  // Resolver wiring (OB-65): mapped exercises climb the §6.5 ladder — known names carry
  // a canonical `id` PLUS the lossless original in `opaque`; curated-null names stay
  // opaque-only.
  it("resolves exercise names through the §6.5 ladder (id + lossless opaque)", () => {
    const refs = ofKind(mapHevy(hevyCsv), "Session")
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

  describe("malformed input (behavior pinned)", () => {
    it("empty input maps to []", () => {
      expect(mapHevy("")).toEqual([]);
    });
    it("header-only CSV maps to []", () => {
      expect(mapHevy("title,start_time,end_time,exercise_title,superset_id,set_type,reps\n")).toEqual([]);
    });
    it("rows missing the expected columns do not throw (garbage in, one garbage session out)", () => {
      const out = mapHevy("a,b\n1,2");
      expect(out).toHaveLength(1);
      expect(ofKind(out, "Session")[0]?.name).toBeUndefined(); // no title column
    });
  });
});
