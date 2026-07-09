// Fitbod mapper: schema + §8.3 round-trip on the sample export, gap-based session
// inference, TZ-independent window arithmetic, id stability under re-export (§7.1), and
// lossless carry of Fitbod-only fields (warmup/incline/resistance) via a namespaced extension.
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapFitbod } from "../../src/mappers/index.js";
import { expectValidAndStable, ofKind, readExample } from "../helpers.js";

const csv = readExample("fitbod/fitbod-sample.csv");

describe("mapFitbod", () => {
  it("maps the sample export to valid, round-trip-stable wire records", () => {
    expectValidAndStable(mapFitbod(csv).records);
  });

  it("infers sessions from the >3h gap between set timestamps", () => {
    const sessions = ofKind(mapFitbod(csv).records, "Session");
    expect(sessions, "Jan 15 and Jan 18 are separate sessions").toHaveLength(2);
  });

  it("maps the session window timezone-independently (start = first set, end = last set + its duration)", () => {
    const [s1] = ofKind(mapFitbod(csv).records, "Session");
    // last Jan-15 set is the treadmill run at 08:30:00 with Duration(s)=600 → ends 08:40:00
    expect(`${s1?.startTime}..${s1?.endTime}`).toBe("2026-01-15T08:00:00Z..2026-01-15T08:40:00Z");
  });

  it("carries Fitbod-only fields losslessly in a namespaced extension", () => {
    const [s1] = ofKind(mapFitbod(csv).records, "Session");
    const wus = (s1?.exercises ?? []).flatMap((e) => e.workUnits ?? []);
    const exts = wus.map((w) => w.extension?.["com.fitbod.export"]).filter(Boolean) as Record<string, unknown>[];
    expect(
      exts.some((e) => e.warmup === true),
      "warmup set flagged",
    ).toBe(true);
    expect(
      exts.some((e) => e.incline === 2),
      "treadmill incline preserved",
    ).toBe(true);
    // the machine Leg Press (resistance 50) is in the second session
    const [, s2] = ofKind(mapFitbod(csv).records, "Session");
    const s2exts = (s2?.exercises ?? [])
      .flatMap((e) => e.workUnits ?? [])
      .map((w) => w.extension?.["com.fitbod.export"]);
    expect(
      s2exts.some((e) => (e as Record<string, unknown>)?.resistance === 50),
      "resistance preserved",
    ).toBe(true);
  });

  it("scores by the populated column (reps / time / distance+time→continuous)", () => {
    const [s1] = ofKind(mapFitbod(csv).records, "Session");
    const exs = s1?.exercises ?? [];
    const bench = exs.find((e) => e.workUnits?.some((w) => w.performance?.load?.value === 80));
    expect(bench?.workUnits?.[0]?.scoring, "reps+weight → reps").toBe("reps");
    const plank = exs.find(
      (e) => e.workUnits?.[0]?.performance?.time === 60 && !e.workUnits?.[0]?.performance?.distance,
    );
    expect(plank?.workUnits?.[0]?.scoring, "duration-only → time").toBe("time");
    const tread = exs.find((e) => e.workUnits?.[0]?.performance?.distance);
    expect(tread?.workUnits?.[0]?.scoring, "distance+time → continuous").toBe("continuous");
  });

  it("keeps session ids stable when the export grows (§7.1 dedup)", () => {
    const base = mapFitbod(csv).records;
    const jan15 = base.find((r) => r.clientRecordId === "2026-01-15 08:00:00");
    expect(jan15?.id).toBeTruthy();
    const [head = "", ...rest] = csv.trim().split("\n");
    const withEarlier = [head, "2026-01-10 07:00:00,Deadlift,5,120,0,0,0,0,false,,1", ...rest].join("\n");
    const grown = mapFitbod(withEarlier).records;
    expect(ofKind(grown, "Session"), "expected 3 sessions after prepending an earlier one").toHaveLength(3);
    const moved = grown.find((r) => r.clientRecordId === "2026-01-15 08:00:00");
    expect(moved?.id, "id not stable under re-export").toBe(jan15?.id);
  });

  it("warns on a missing subject and throws on a structurally-wrong header", () => {
    const res = mapFitbod(csv);
    expect(res.warnings.some((w) => w.code === "default-subject")).toBe(true);
    expect(() => mapFitbod("Foo,Bar\n1,2")).toThrow(MapperInputError);
  });
});
