// Unit tests for the semantic checks in src/validate.ts — the intra-record rules the
// JSON Schema can't express. One valid + one invalid fixture per rule, asserting on
// the rule's error-message branch. Uses the browser-safe validator (vendored schema),
// exactly what package consumers get.
import { describe, expect, it } from "vitest";
import type { WireRecord } from "../src/types.js";
import { validate } from "../src/validate.js";

const workUnit = (over: WireRecord) => ({
  id: "wu-1",
  recordType: "WorkUnit",
  scoring: "reps",
  ...over,
});

describe("checkLoadUnit (§5.12 Load.unit conditional)", () => {
  it("scalar load value without unit → invalid", () => {
    const v = validate(workUnit({ performance: { reps: 5, load: { value: 100 } } }));
    expect(v.valid).toBe(false);
    expect(v.errors).toContain("Load.unit is required when value is a scalar (§5.12)");
  });
  it("scalar load value with unit → valid", () => {
    const v = validate(workUnit({ performance: { reps: 5, load: { value: 100, unit: "kg" } } }));
    expect(v.errors).toBeNull();
    expect(v.valid).toBe(true);
  });
  it("absolute Target with neither sibling nor nested unit → invalid", () => {
    const v = validate(workUnit({ performance: { reps: 5, load: { value: { absolute: { value: 100 } } } } }));
    expect(v.valid).toBe(false);
    expect(v.errors).toContain("Load.unit is required when value is an absolute Target");
  });
  it("absolute Target with the unit nested inside value.absolute → valid (pre-fold location)", () => {
    const v = validate(
      workUnit({ performance: { reps: 5, load: { value: { absolute: { value: 100, unit: "kg" } } } } }),
    );
    expect(v.errors).toBeNull();
    expect(v.valid).toBe(true);
  });
  it("relativeToThreshold with a unit → invalid (unit derives from the threshold)", () => {
    const v = validate(
      workUnit({
        prescription: { reps: 5, load: { value: { relativeToThreshold: { percent: 80, of: "1RM" } }, unit: "kg" } },
      }),
    );
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('Load.unit MUST be omitted when value is "relativeToThreshold" (§5.12)');
  });
  it("relativeToThreshold without a unit → valid", () => {
    const v = validate(
      workUnit({ prescription: { reps: 5, load: { value: { relativeToThreshold: { percent: 80, of: "1RM" } } } } }),
    );
    expect(v.errors).toBeNull();
    expect(v.valid).toBe(true);
  });
  it("stopCondition with a unit → invalid", () => {
    const v = validate(
      workUnit({
        scoring: "time",
        prescription: { time: 60, load: { value: { stopCondition: { kind: "failure" } }, unit: "kg" } },
      }),
    );
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('Load.unit MUST be omitted when value is "stopCondition" (§5.12)');
  });

  // §5.12 leaves `ramp` deliberately unconstrained (SPEC.md is silent) — Load.unit is neither
  // required (unlike scalar/absolute) nor forbidden (unlike relativeToThreshold). Pin both.
  it("ramp load WITH a sibling Load.unit → valid (unit permitted)", () => {
    const v = validate(
      workUnit({ prescription: { reps: 5, load: { value: { ramp: { from: 100, to: 120 } }, unit: "kg" } } }),
    );
    expect(v.errors).toBeNull();
    expect(v.valid).toBe(true);
  });
  it("ramp load WITHOUT any unit → valid (unit not required)", () => {
    const v = validate(workUnit({ prescription: { reps: 5, load: { value: { ramp: { from: 100, to: 120 } } } } }));
    expect(v.errors).toBeNull();
    expect(v.valid).toBe(true);
  });
});

describe("checkScoringMetric (§5.5 scoring ↔ metric agreement)", () => {
  it("reps-scored unit carrying performance.time → invalid", () => {
    const v = validate(workUnit({ performance: { reps: 5, time: { absolute: { value: 60, unit: "s" } } } }));
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('performance.time contradicts scoring:"reps" (§5.5)');
  });
  it("continuous unit MAY carry distance+time+energy together → valid", () => {
    const v = validate(
      workUnit({
        scoring: "continuous",
        performance: {
          distance: { absolute: { value: 5000, unit: "m" } },
          time: { absolute: { value: 1200, unit: "s" } },
          energy: { absolute: { value: 300, unit: "kcal" } },
        },
      }),
    );
    expect(v.errors).toBeNull();
    expect(v.valid).toBe(true);
  });
  it("continuous unit carrying reps → invalid (continuous excludes reps)", () => {
    const v = validate(workUnit({ scoring: "continuous", performance: { reps: 10 } }));
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('performance.reps contradicts scoring:"continuous" (§5.5)');
  });
  it("the rule applies to prescription too", () => {
    const v = validate(workUnit({ scoring: "time", prescription: { time: 60, distance: 100 } }));
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('prescription.distance contradicts scoring:"time" (§5.5)');
  });
});

describe("checkSetsPerformance (§5.5 sets is a planned shorthand)", () => {
  it("prescription.sets + performance → invalid", () => {
    const v = validate(workUnit({ prescription: { sets: 3, reps: 5 }, performance: { reps: 5 } }));
    expect(v.valid).toBe(false);
    expect(v.errors).toContain("carries prescription.sets and performance — mutually exclusive (§5.5)");
  });
  it("prescription.sets alone → valid", () => {
    const v = validate(workUnit({ prescription: { sets: 3, reps: 5 } }));
    expect(v.errors).toBeNull();
    expect(v.valid).toBe(true);
  });
});

describe("checkTombstone (§7.1/§7.5 strictly id/recordType/status)", () => {
  it("a deleted record carrying payload fields → invalid", () => {
    const v = validate({
      id: "m-1",
      recordType: "Measurement",
      status: "deleted",
      type: "body_mass",
      quantity: 80,
      unit: "kg",
    });
    expect(v.valid).toBe(false);
    expect(v.errors).toContain("carries fields beyond id/recordType/status");
  });
  it("a strict tombstone → valid", () => {
    const v = validate({ id: "m-1", recordType: "Measurement", status: "deleted" });
    expect(v.errors).toBeNull();
    expect(v.valid).toBe(true);
  });
});

describe("checkExerciseRefEnclosing (§5.5 exerciseRef vs enclosing Exercise)", () => {
  it("a WorkUnit inside an Exercise carrying its own exerciseRef → invalid", () => {
    const v = validate({
      id: "ex-1",
      recordType: "Exercise",
      exerciseRef: { id: "squat.barbell.high-bar" },
      workUnits: [workUnit({ exerciseRef: { opaque: "Squat" }, performance: { reps: 5 } })],
    });
    expect(v.valid).toBe(false);
    expect(v.errors).toContain("carries exerciseRef but its enclosing Exercise");
  });
  it("children without their own exerciseRef → valid", () => {
    const v = validate({
      id: "ex-1",
      recordType: "Exercise",
      exerciseRef: { id: "squat.barbell.high-bar" },
      workUnits: [workUnit({ performance: { reps: 5 } })],
    });
    expect(v.errors).toBeNull();
    expect(v.valid).toBe(true);
  });
});

describe("checkThresholdEstimationProvenance (§5.11 / OB-32)", () => {
  const profile = (entry: WireRecord) => ({
    id: "tp-1",
    recordType: "ThresholdProfile",
    entries: [{ kind: "1RM", value: 140, unit: "kg", ...entry }],
  });
  it("source:tested with estimationFormula → invalid", () => {
    const v = validate(profile({ source: "tested", estimationFormula: "epley" }));
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('estimationFormula MUST NOT be present when source is "tested" (§5.11)');
  });
  it("source:tested with estimatedFrom → invalid", () => {
    const v = validate(profile({ source: "tested", estimatedFrom: { reps: 5, load: { value: 120, unit: "kg" } } }));
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('estimatedFrom MUST NOT be present when source is "tested" (§5.11)');
  });
  it("source:estimated with both provenance fields → valid", () => {
    const v = validate(
      profile({
        source: "estimated",
        estimationFormula: "epley",
        estimatedFrom: { reps: 5, load: { value: 120, unit: "kg" } },
      }),
    );
    expect(v.errors).toBeNull();
    expect(v.valid).toBe(true);
  });
});

describe("validateProgramPhases (§5.2 phase/session cross-checks)", () => {
  it("a phase referencing a session absent from top-level sessions → invalid", () => {
    const v = validate({
      id: "p-1",
      recordType: "Program",
      sessions: ["s-1"],
      phases: [{ name: "base", sessions: ["s-2"] }],
    });
    expect(v.valid).toBe(false);
    expect(v.errors).toContain('references "s-2" which is absent from top-level sessions (§5.2)');
  });
  it("a session id in two phases → invalid (phases are disjoint)", () => {
    const v = validate({
      id: "p-1",
      recordType: "Program",
      sessions: ["s-1"],
      phases: [
        { name: "a", sessions: ["s-1"] },
        { name: "b", sessions: ["s-1"] },
      ],
    });
    expect(v.valid).toBe(false);
    expect(v.errors).toContain("appears in more than one phase's sessions — phases MUST be disjoint (§5.2)");
  });
  it("phases partitioning top-level sessions → valid", () => {
    const v = validate({
      id: "p-1",
      recordType: "Program",
      sessions: ["s-1", "s-2"],
      phases: [
        { name: "a", sessions: ["s-1"] },
        { name: "b", sessions: ["s-2"] },
      ],
    });
    expect(v.errors).toBeNull();
    expect(v.valid).toBe(true);
  });
});

describe("semantic checks walk the inlined tree (§5.1)", () => {
  it("a violation deep inside Session.blocks[].children[] is caught", () => {
    const v = validate({
      id: "s-1",
      recordType: "Session",
      subject: "u-1",
      blocks: [
        {
          id: "b-1",
          recordType: "Block",
          children: [workUnit({ performance: { reps: 5, load: { value: 100 } } })],
        },
      ],
    });
    expect(v.valid).toBe(false);
    expect(v.errors).toContain("Load.unit is required when value is a scalar (§5.12)");
  });
});
