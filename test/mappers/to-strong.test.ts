// Outbound mapper (OpenBody → Strong CSV): full-fixture round-trip through mapStrong,
// the coverage matrix (duration/distance/bodyweight/lb→kg/RPE), the SPEC §10
// degradation policy (omissions report + strict mode), Session.workUnits handling,
// and cross-app name preservation. Ported from scripts/test-mappers.ts.
import { describe, expect, it } from "vitest";
import { parseCsv } from "../../src/mappers/csv.js";
import { mapHevy, mapOpenBodyToStrong, mapStrong } from "../../src/mappers/index.js";
import { equivalent } from "../../src/normalize.js";
import type { Exercise, OpenBodyRecord, Session, WorkUnit } from "../../src/types.js";
import { expectAllValid, ofKind, readExample } from "../helpers.js";

const session = (over: Partial<Session>): Session => ({
  id: "s1",
  recordType: "Session",
  subject: "subj-001",
  disciplines: ["strength"],
  startTime: "2026-01-01T10:00:00Z",
  endTime: "2026-01-01T11:00:00Z",
  name: "Test",
  ...over,
});
const exercise = (workUnits: WorkUnit[], id = "e1"): Exercise => ({
  id,
  recordType: "Exercise",
  exerciseRef: { opaque: "Some Movement" },
  workUnits,
});
const row = (records: OpenBodyRecord[]) => {
  const out = mapOpenBodyToStrong(records);
  return { ...out, rows: parseCsv(out.csv) };
};

describe("mapOpenBodyToStrong", () => {
  // Outbound round-trip: mapOpenBodyToStrong is the mirror of mapStrong. It covers the
  // full fixture — including the Plank duration-scored row — with zero omissions.
  it("round-trips the Strong fixture (Strong → OpenBody → Strong → OpenBody) with 0 omissions", () => {
    const original = mapStrong(readExample("strong/strong-sample.csv"));
    expect(original.length, "fixture mapped 0 records").toBeGreaterThan(0);
    const out = mapOpenBodyToStrong(original);
    expect(out.omissions, "expected 0 omissions for the Strong fixture").toEqual([]);
    const roundTripped = mapStrong(out.csv);
    expectAllValid(roundTripped);
    expect(
      equivalent(original, roundTripped),
      "outbound round-trip (Strong → OpenBody → Strong → OpenBody) not equivalent",
    ).toBe(true);
    // The duration-scored Plank row must survive: Seconds column carries the hold time.
    const plank = parseCsv(out.csv).find((r) => r["Exercise Name"] === "Plank");
    expect(plank?.Seconds, `Plank duration set: ${JSON.stringify(plank)}`).toBe("60");
  });

  describe("coverage: what Strong's CSV can hold maps faithfully", () => {
    it("duration set: explicit non-second unit converts exactly (2 min → 120 s)", () => {
      const dur = row([
        session({
          exercises: [
            exercise([
              {
                id: "w1",
                recordType: "WorkUnit",
                scoring: "time",
                performance: { time: { absolute: { value: 2, unit: "min" } } },
              },
            ]),
          ],
        }),
      ]);
      expect(dur.rows[0]?.Seconds).toBe("120");
      expect(dur.omissions).toEqual([]);
    });

    it("distance set: km → metres with an exact decimal shift (5.3 km → 5300)", () => {
      const dist = row([
        session({
          exercises: [
            exercise([
              {
                id: "w1",
                recordType: "WorkUnit",
                scoring: "distance",
                performance: { distance: { absolute: { value: 5.3, unit: "km" } } },
              },
            ]),
          ],
        }),
      ]);
      expect(dist.rows[0]?.Distance, "no float dust").toBe("5300");
      expect(dist.omissions).toEqual([]);
      // round-trips through mapStrong as { value: 5300, unit: "m" }
      const distBack = ofKind(mapStrong(dist.csv), "Session")[0]?.exercises?.[0]?.workUnits?.[0]?.performance?.distance;
      expect(distBack).toEqual({ absolute: { value: 5300, unit: "m" } });
    });

    it("bodyweight / reps-only set: Reps carried, Weight stays 0, no load on re-import", () => {
      const bw = row([
        session({
          exercises: [exercise([{ id: "w1", recordType: "WorkUnit", scoring: "reps", performance: { reps: 12 } }])],
        }),
      ]);
      expect(bw.rows[0]?.Reps).toBe("12");
      expect(bw.rows[0]?.Weight).toBe("0");
      expect(bw.omissions).toEqual([]);
      expect(
        ofKind(mapStrong(bw.csv), "Session")[0]?.exercises?.[0]?.workUnits?.[0]?.performance?.load,
        "re-import grew a load",
      ).toBeUndefined();
    });

    it("kg conversion: [lb_av] → kg with exact decimal math (225 lb → 102.05828325 kg)", () => {
      const lb = row([
        session({
          exercises: [
            exercise([
              {
                id: "w1",
                recordType: "WorkUnit",
                scoring: "reps",
                performance: { reps: 5, load: { value: 225, unit: "[lb_av]", basis: "marked_weight" } },
              },
            ]),
          ],
        }),
      ]);
      expect(lb.rows[0]?.Weight).toBe("102.05828325");
      expect(lb.omissions).toEqual([]);
    });

    it("RPE where present → the RPE column", () => {
      const rpe = row([
        session({
          exercises: [
            exercise([
              {
                id: "w1",
                recordType: "WorkUnit",
                scoring: "reps",
                performance: { reps: 5, effortLoad: [{ kind: "internal", method: "RPE", value: 8.5 }] },
              },
            ]),
          ],
        }),
      ]);
      expect(rpe.rows[0]?.RPE).toBe("8.5");
      expect(rpe.omissions).toEqual([]);
    });
  });

  // Session.workUnits (the collapsed §5.1 hierarchy strava/fit/tcx/gpx/concept2/thecrag
  // produce): a unit naming its own exercise emits a row; a ref-less one has no Exercise
  // Name to write and must land in the omissions report, not vanish silently.
  it("emits self-naming Session.workUnits and reports ref-less ones", () => {
    const wus = row([
      session({
        workUnits: [
          {
            id: "wu1",
            recordType: "WorkUnit",
            exerciseRef: { opaque: "RowErg" },
            scoring: "time",
            performance: { time: { absolute: { value: 300, unit: "s" } } },
          },
          {
            id: "wu2",
            recordType: "WorkUnit",
            scoring: "continuous",
            performance: { distance: { absolute: { value: 5000, unit: "m" } } },
          },
        ],
      }),
    ]);
    expect(wus.rows).toHaveLength(1);
    expect(wus.rows[0]?.["Exercise Name"]).toBe("RowErg");
    expect(wus.rows[0]?.Seconds).toBe("300");
    expect(
      wus.omissions.some((o) => o.recordId === "wu2" && o.field === "exerciseRef"),
      `ref-less session.workUnit not reported: ${JSON.stringify(wus.omissions)}`,
    ).toBe(true);
  });

  // Degradation policy: a superset Block flattens to plain sets (both rows emitted) and
  // a %1RM load has no absolute kg value — both reported with recordIds, neither fatal.
  const lossy = () => [
    session({
      blocks: [
        {
          id: "blk1",
          recordType: "Block",
          grouping: "superset",
          children: [
            exercise(
              [
                {
                  id: "w1",
                  recordType: "WorkUnit",
                  scoring: "reps",
                  performance: {
                    reps: 5,
                    load: { value: { relativeToThreshold: { percent: 80, of: "1RM" } }, basis: "marked_weight" },
                  },
                },
              ],
              "e1",
            ),
            exercise([{ id: "w2", recordType: "WorkUnit", scoring: "reps", performance: { reps: 10 } }], "e2"),
          ],
        },
      ],
    }),
  ];

  it("degrades supersets + %1RM loads into a machine-readable omissions report", () => {
    const deg = row(lossy());
    expect(deg.rows, "superset flatten: both children emitted as plain sets").toHaveLength(2);
    expect(
      deg.omissions.some((o) => o.recordId === "blk1" && o.field === "grouping"),
      `no grouping omission: ${JSON.stringify(deg.omissions)}`,
    ).toBe(true);
    expect(
      deg.omissions.some((o) => o.recordId === "w1" && o.field === "load"),
      `no %1RM load omission: ${JSON.stringify(deg.omissions)}`,
    ).toBe(true);
    expect(deg.rows[0]?.Weight, "%1RM set should keep reps, zero weight").toBe("0");
    expect(deg.rows[0]?.Reps).toBe("5");
  });

  it("strict mode throws on the same lossy document instead of degrading", () => {
    expect(() => mapOpenBodyToStrong(lossy(), { strict: true })).toThrow();
  });

  // Crossing apps preserves names: Hevy → OpenBody → Strong CSV re-emits Hevy's own
  // exercise strings byte-for-byte (to-strong.ts prefers `opaque`).
  it("re-emits Hevy's original exercise names byte-for-byte", () => {
    const hevyRecords = mapHevy(readExample("hevy/hevy-sample.csv"));
    const outCsv = mapOpenBodyToStrong(hevyRecords).csv;
    const outNames = new Set(parseCsv(outCsv).map((r) => r["Exercise Name"]));
    for (const orig of [
      "Leg Press (Machine)",
      "Crunch (Weighted)",
      "Seated Shoulder Press (Machine)",
      "Pull Up (Assisted)",
    ]) {
      expect(outNames.has(orig), `hevy→strong CSV dropped/renamed "${orig}" (got: ${[...outNames].join(" | ")})`).toBe(
        true,
      );
    }
  });

  describe("malformed input (behavior pinned)", () => {
    it("empty document → header-only CSV, no omissions", () => {
      const out = mapOpenBodyToStrong([]);
      expect(out.omissions).toEqual([]);
      expect(out.csv.trim().split("\n")).toHaveLength(1); // just the header
    });
    it("non-Session records are skipped with an omission", () => {
      const out = mapOpenBodyToStrong([{ id: "m1", recordType: "Measurement" } as OpenBodyRecord]);
      expect(out.omissions).toHaveLength(1);
      expect(out.omissions[0]?.recordId).toBe("m1");
    });
  });
});
