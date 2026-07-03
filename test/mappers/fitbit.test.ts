// Fitbit (Google Takeout) mapper tests (OB-80). Covers: every wire record
// schema-validates + normalization round-trips, sleep stages are ADJACENT category
// Measurements (incl. the shortData wake spliced into the deep segment), weight is
// exact fixed-point in [lb_av], discipline mapping + the fitbit:<name> fallback,
// intraday steps/HR collapse to one sampleArray per day, and unknown/empty/corrupt
// files are ignored gracefully. Ported from scripts/test-fitbit.ts.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MapperInputError } from "../../src/errors.js";
import { mapFitbitTakeout } from "../../src/mappers/fitbit.js";
import { abs, examplesDir, expectValidAndStable, ofKind } from "../helpers.js";

const dir = path.join(examplesDir, "fitbit");
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), "utf8") }));

const { records } = mapFitbitTakeout(files, { utcOffset: "-08:00" });
const measurements = ofKind(records, "Measurement");

describe("mapFitbitTakeout", () => {
  // 1. Every wire record validates; normalization is idempotent (§8.3 round-trip).
  it("maps the sample Takeout to valid, round-trip-stable wire records", () => {
    expectValidAndStable(records);
  });

  // 2. Sleep: category Measurements over ADJACENT intervals (§4.3), with the 2-min
  // shortData wake spliced into the deep segment (5 data segments → 7).
  it("emits adjacent sleep stages with the short wake spliced in, plus summary quantities", () => {
    const stages = measurements
      .filter((r) => r.type === "sleep_stage")
      .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
    expect(stages, "expected 7 stage intervals (5 data + deep split by 1 short wake)").toHaveLength(7);
    for (let i = 0; i < stages.length - 1; i++) {
      expect(stages[i]?.endTime, `gap/overlap between ${stages[i]?.id} and ${stages[i + 1]?.id}`).toBe(
        stages[i + 1]?.startTime,
      );
    }
    expect(stages.map((s) => s.category).join(",")).toBe("awake,light,deep,awake,deep,rem,light");
    for (const s of stages) {
      expect(s.quantity, `${s.id} has both category and quantity`).toBeUndefined();
      expect(s.unit, `${s.id}: category Measurement must not carry a unit`).toBeUndefined();
    }
    // Fitbit's own summary → registry sleep tokens as interval quantities over the log window.
    for (const [type, mins] of [
      ["sleep_duration", 168],
      ["sleep_deep", 58],
      ["sleep_light", 80],
      ["sleep_rem", 30],
      ["sleep_awake", 8],
    ] as const) {
      const r = measurements.find((x) => x.type === type);
      expect(r, `missing ${type}`).toBeDefined();
      expect(r?.quantity, type).toBe(mins);
      expect(r?.unit).toBe("min");
      expect(r?.startTime).toBe("2024-01-05T23:04:00-08:00");
      expect(r?.endTime).toBe("2024-01-06T02:00:00-08:00");
    }
  });

  // 3. Weight: exact §4.2 fixed-point in [lb_av] (175.5 → 1755e-1; integer 175 → 175e0),
  // Aria scale → sensor+device, API entry → manual; bmi + fat ride along.
  it("keeps weight as exact fixed-point in [lb_av] with honest provenance", () => {
    const w = measurements.filter((r) => r.type === "body_mass");
    expect(w, "expected 2 body_mass records").toHaveLength(2);
    const aria = w.find((r) => r.id === "fitbit-weight-1704526260000");
    expect(aria?.quantity).toEqual({ coefficient: 1755, exponent: -1 });
    expect(aria?.unit).toBe("[lb_av]");
    expect(aria?.provenance?.method).toBe("sensor");
    expect(aria?.provenance?.device?.model).toBe("Aria");
    expect(aria?.clientRecordId).toBe("1704526260000");
    const manual = w.find((r) => r.id === "fitbit-weight-1704612600000");
    expect(manual?.quantity).toEqual({ coefficient: 175, exponent: 0 });
    expect(manual?.provenance?.method).toBe("manual");
    const fat = measurements.find((r) => r.type === "body_fat_percentage");
    expect(fat?.quantity).toEqual({ coefficient: 215, exponent: -1 });
    expect(measurements.filter((r) => r.type === "bmi")).toHaveLength(2);
  });

  // 4. Sessions: activityName → canonical discipline; unknown name → fitbit:<name>
  // fallback; summary aggregates hang off the WorkUnit via measuredBy.
  it("maps exercise logs to Sessions with disciplines + measuredBy aggregates", () => {
    const run = ofKind(records, "Session").find((r) => r.id === "fitbit-ex-21092332392");
    expect(run, "missing Run session").toBeDefined();
    expect(run?.disciplines).toEqual(["running"]);
    expect(run?.clientRecordId).toBe("21092332392");
    expect(run?.startTime).toBe("2024-01-06T07:08:57-08:00");
    expect(run?.endTime).toBe("2024-01-06T07:39:40-08:00");
    const perf = run?.workUnits?.[0]?.performance;
    expect(abs(perf?.time)?.value).toBe(1843);
    expect(abs(perf?.distance)?.value).toBe(5.28);
    expect(abs(perf?.distance)?.unit).toBe("km");
    expect(abs(perf?.energy)?.value).toBe(306);
    const refs = (run?.workUnits?.[0]?.links ?? []).filter((l) => l.type === "measuredBy").map((l) => l.ref);
    for (const ref of ["fitbit-ex-21092332392-hr-mean", "fitbit-ex-21092332392-steps"]) {
      expect(refs, `missing measuredBy aggregate ${ref}`).toContain(ref);
      expect(records.find((r) => r.id === ref)).toBeDefined();
    }
    expect(run?.extension?.fitbit?.heartRateZones, "heartRateZones not preserved in extension").toBeDefined();

    const ell = ofKind(records, "Session").find((r) => r.id === "fitbit-ex-21092332999");
    expect(ell?.disciplines).toEqual(["fitbit:elliptical"]);
    expect(ell?.provenance?.method).toBe("manual");
    expect(ell?.workUnits?.[0]?.links, "Elliptical (no aggregates) should have no links").toBeUndefined();
  });

  // 5. Intraday volume: one sampleArray per day per stream, offsets from timestamps.
  it("collapses intraday steps/HR to one sampleArray per day (HR in UTC, steps local) + daily RHR", () => {
    const hr = measurements.filter((r) => r.type === "heart_rate" && r.sampleArray);
    expect(hr, "expected 1 HR day-series").toHaveLength(1);
    const hrSa = hr[0]?.sampleArray;
    expect(hrSa?.offsets).toHaveLength(10);
    expect(hrSa?.dataPoints).toHaveLength(10);
    expect(hrSa?.offsets?.[0]).toBe(0);
    expect(hrSa?.offsets?.[9]).toBe(105);
    expect(hr[0]?.unit).toBe("/min");
    expect(hrSa?.dataPoints?.[0]).toBe(76);
    expect(hr[0]?.startTime?.endsWith("Z"), `HR timestamps are documented UTC; startTime=${hr[0]?.startTime}`).toBe(
      true,
    );
    expect(hr[0]?.endTime).toBe("2024-01-06T07:01:46Z");

    const st = measurements.filter((r) => r.type === "step_count" && r.sampleArray);
    expect(st, "expected 1 steps day-series").toHaveLength(1);
    const stSa = st[0]?.sampleArray;
    expect(stSa?.dataPoints).toHaveLength(8);
    expect(stSa?.dataPoints?.[2]).toBe(64);
    expect(stSa?.offsets?.[7], "want 660 — 11 min, incl. the bucket gap").toBe(660);
    expect(st[0]?.startTime?.endsWith("-08:00"), `steps are local time; startTime=${st[0]?.startTime}`).toBe(true);

    const rhr = measurements.filter((r) => r.type === "resting_heart_rate");
    expect(rhr, "zero-value RHR day must be skipped").toHaveLength(1);
    expect(rhr[0]?.startTime).toBe("2024-01-06T00:00:00-08:00");
    expect(rhr[0]?.endTime).toBe("2024-01-07T00:00:00-08:00");
  });

  // 6. Robustness: unknown names, corrupt JSON, non-array JSON, empty input → no throw,
  // no records — but each skipped/ignored file is now REPORTED on the warnings channel.
  describe("errors + warnings (WP7 contract)", () => {
    it("junk/corrupt/non-array files are skipped with per-file warnings", () => {
      const junk = mapFitbitTakeout([
        { name: "sessions.csv", text: "a,b\n1,2" },
        { name: "exercise-1.json", text: "{ not json" },
        { name: "steps-2024-01-01.json", text: '{"not":"an array"}' },
        { name: "heart_rate-2024-01-02.json", text: "[]" },
        { name: "Takeout/Fitbit/Global Export Data/weight-2024-02-01.json", text: "[]" },
      ]);
      expect(junk.records).toEqual([]);
      const by = (code: string) => junk.warnings.filter((w) => w.code === code).map((w) => w.context?.file);
      expect(by("unrecognized-file")).toEqual(["sessions.csv"]);
      expect(by("skipped-file")).toEqual(["exercise-1.json", "steps-2024-01-01.json"]);
    });
    it("a clean mapping of the sample emits no warnings beyond default-subject", () => {
      const out = mapFitbitTakeout(files, { utcOffset: "-08:00" });
      expect(out.warnings.map((w) => w.code)).toEqual(["default-subject"]);
      expect(mapFitbitTakeout(files, { utcOffset: "-08:00", subject: "me" }).warnings).toEqual([]);
    });
    it("a files list that is not { name, text } objects throws MapperInputError", () => {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input
      expect(() => mapFitbitTakeout("exercise-1.json" as any)).toThrow(MapperInputError);
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input
      expect(() => mapFitbitTakeout([{ name: "exercise-1.json" }] as any)).toThrow(MapperInputError);
    });
    it("empty input maps to an empty result (an empty subset is a valid subset)", () => {
      const out = mapFitbitTakeout([]);
      expect(out.records).toEqual([]);
    });
    it("nested Takeout paths classify by basename", () => {
      const weightText = files.find((f) => f.name === "weight-2024-01-01.json")?.text ?? "[]";
      const nested = mapFitbitTakeout([
        { name: "Takeout/Fitbit/Global Export Data/weight-2024-01-01.json", text: weightText },
      ]).records;
      expect(ofKind(nested, "Measurement").filter((r) => r.type === "body_mass")).toHaveLength(2);
    });
    it("entries missing logId/startTime are skipped with a per-file skipped-entries warning", () => {
      const ex = mapFitbitTakeout([{ name: "exercise-1.json", text: JSON.stringify([{ activityName: "Run" }]) }]);
      expect(ex.records).toEqual([]);
      expect(ex.warnings.find((w) => w.code === "skipped-entries")?.context).toEqual({
        file: "exercise-1.json",
        count: 1,
      });
      const sl = mapFitbitTakeout([{ name: "sleep-2024-01-01.json", text: JSON.stringify([{ duration: 1000 }]) }]);
      expect(sl.records).toEqual([]);
      expect(sl.warnings.some((w) => w.code === "skipped-entries")).toBe(true);
    });
    it("an unrecognized distanceUnit routes the raw pair to extension residue WITH a warning", () => {
      const out = mapFitbitTakeout([
        {
          name: "exercise-9.json",
          text: JSON.stringify([
            {
              logId: 1,
              activityName: "Run",
              startTime: "01/06/24 07:00:00",
              duration: 60000,
              distance: 3.1,
              distanceUnit: "Furlong",
            },
          ]),
        },
      ]);
      const w = out.warnings.find((x) => x.code === "unknown-distance-unit");
      expect(w?.context).toEqual({ file: "exercise-9.json", logId: "1", distanceUnit: "Furlong" });
      const session = ofKind(out.records, "Session")[0];
      expect(session?.extension?.fitbit?.distance).toBe(3.1);
      expect(session?.extension?.fitbit?.distanceUnit).toBe("Furlong");
      expect(session?.workUnits?.[0]?.performance?.distance, "unrecognized unit must not be mapped").toBeUndefined();
    });
  });
});
