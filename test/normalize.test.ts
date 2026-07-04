// Hermetic in-repo tests for the equivalence oracle (src/normalize.ts, SPEC §8.3 /
// conformance/EQUIVALENCE.md). normalizeDocument returns sorted canonical byte strings;
// these build small documents, parse the canonical bytes back, and pin the EXACT
// expanded/flattened records. The only other behavioural coverage is the sibling-repo
// conformance vectors, which silently skip on a bare clone — so this file is the oracle's
// standalone safety net.
import { describe, expect, it } from "vitest";
import { equivalent, type NormalizeInput, normalizeDocument } from "../src/normalize.js";
import type { WireRecord } from "../src/types.js";

// Normalize, then parse the canonical bytes back to records. Every record has a unique id
// after flatten (synthesized where the source omitted one), so `by(id)` is unambiguous.
const norm = (doc: NormalizeInput): WireRecord[] => normalizeDocument(doc).map((s) => JSON.parse(s) as WireRecord);
const by = (recs: WireRecord[], id: string): WireRecord | undefined => recs.find((r) => r.id === id);
const wusOf = (recs: WireRecord[]) => recs.filter((r) => r.recordType === "WorkUnit");
// The canonical (§8.3 step 1) form of a small integer metric wrapped as an absolute Target.
const absInt = (n: string) => ({ absolute: { value: { coefficient: n, exponent: "0" } } });

describe("normalizeDocument: sets:N expansion (EQUIVALENCE.md step 5 / §5.5)", () => {
  it("expands prescription.sets:3 into 3 WorkUnits — first keeps id+position, copies get synthesized ids, sets removed", () => {
    const recs = norm({
      id: "s1",
      recordType: "Session",
      subject: "u1",
      workUnits: [
        { id: "w1", recordType: "WorkUnit", scoring: "reps", position: 1, prescription: { sets: 3, reps: 5 } },
      ],
    });
    expect(wusOf(recs)).toHaveLength(3);
    expect(recs.map((r) => r.id).sort()).toEqual(["s1", "s1#workUnits#2", "s1#workUnits#3", "w1"]);
    // The first copy keeps the source id AND its position; the two later copies are id-stripped
    // then re-synthesized positionally (#workUnits#2/#3).
    expect(by(recs, "w1")?.position).toEqual({ coefficient: "1", exponent: "0" });
    for (const w of wusOf(recs)) {
      expect(w.prescription.sets, "the sets shorthand must be consumed, not left on the wire").toBeUndefined();
      expect(w.prescription.reps).toEqual(absInt("5"));
    }
  });
});

describe("normalizeDocument: roundScheme ladder (EQUIVALENCE.md step 5 / §5.4)", () => {
  it("expands Block.roundScheme:[21,15,9] into 3 in-order copies, injecting each round's value into the primary metric", () => {
    const recs = norm({
      id: "b1",
      recordType: "Block",
      subject: "u1",
      roundScheme: [21, 15, 9],
      children: [{ id: "w1", recordType: "WorkUnit", scoring: "reps", exerciseRef: "thruster" }],
    });
    expect(wusOf(recs)).toHaveLength(3);
    // Copy 1 (round 21) keeps the source id; copies 2..n are id-stripped then re-synthesized.
    expect(by(recs, "w1")?.prescription.reps).toEqual(absInt("21"));
    expect(by(recs, "b1#children#2")?.prescription.reps).toEqual(absInt("15"));
    expect(by(recs, "b1#children#3")?.prescription.reps).toEqual(absInt("9"));
    for (const w of wusOf(recs)) expect(w.exerciseRef).toEqual({ id: "thruster" });
    expect(by(recs, "b1")?.roundScheme, "the roundScheme shorthand must be consumed").toBeUndefined();
  });
});

describe("normalizeDocument: context propagation (flatten / §7.2)", () => {
  it("a child inherits the nearest ancestor's subject/startTime/endTime; an explicit child value wins", () => {
    const recs = norm({
      id: "s1",
      recordType: "Session",
      subject: "u1",
      startTime: "2026-01-01T10:00:00Z",
      endTime: "2026-01-01T11:00:00Z",
      workUnits: [
        { id: "w1", recordType: "WorkUnit", scoring: "reps", performance: { reps: 5 } },
        { id: "w2", recordType: "WorkUnit", scoring: "reps", subject: "other", performance: { reps: 5 } },
      ],
    });
    expect(by(recs, "w1")?.subject).toBe("u1"); // inherited
    expect(by(recs, "w1")?.startTime).toBe("2026-01-01T10:00:00Z");
    expect(by(recs, "w1")?.endTime).toBe("2026-01-01T11:00:00Z");
    expect(by(recs, "w2")?.subject, "an explicit child subject must not be overwritten by propagation").toBe("other");
  });
});

describe("normalizeDocument: tombstone short-circuit (status:deleted / §7.1/§7.5)", () => {
  it("a top-level tombstone passes through untouched — no status:active default, no subject, no links", () => {
    const recs = norm([
      { id: "s1", recordType: "Session", subject: "u1" },
      { id: "m-1", recordType: "Measurement", status: "deleted" },
    ]);
    // The deleted record is emitted with strictly what it came in with (§7.5 wire shape).
    expect(by(recs, "m-1")).toEqual({ id: "m-1", recordType: "Measurement", status: "deleted" });
    expect(by(recs, "s1")?.status, "a live sibling still gets the status:active default").toBe("active");
  });

  it("a deleted child is not transformed and inherits no subject (the short-circuit skips both)", () => {
    const recs = norm({
      id: "s1",
      recordType: "Session",
      subject: "u1",
      workUnits: [{ id: "w1", recordType: "WorkUnit", scoring: "reps", status: "deleted", performance: { reps: 5 } }],
    });
    const w = by(recs, "w1");
    expect(w?.status).toBe("deleted");
    expect(w?.subject, "a deleted child must not inherit the Session's subject").toBeUndefined();
    // Short-circuit proof: the scalar metric is NOT expanded to {absolute:{value}} — it stays
    // the raw canonicalized number (contrast the live children above).
    expect(w?.performance.reps).toEqual({ coefficient: "5", exponent: "0" });
    // partOf is added by the PARENT before the child short-circuits, so it survives.
    expect(w?.links).toEqual([{ type: "partOf", ref: "s1" }]);
  });
});

describe("normalizeDocument: foldExerciseRef (§6)", () => {
  it("strips the openbody: prefix and object-wraps a bare-string exerciseRef", () => {
    const pref = norm({
      id: "w1",
      recordType: "WorkUnit",
      scoring: "reps",
      subject: "u1",
      exerciseRef: "openbody:squat.barbell.high-bar",
      performance: { reps: 5 },
    });
    expect(by(pref, "w1")?.exerciseRef).toEqual({ id: "squat.barbell.high-bar" });
    const bare = norm({
      id: "w2",
      recordType: "WorkUnit",
      scoring: "reps",
      subject: "u1",
      exerciseRef: "squat.barbell.high-bar",
      performance: { reps: 5 },
    });
    expect(by(bare, "w2")?.exerciseRef).toEqual({ id: "squat.barbell.high-bar" });
  });
});

describe("normalizeDocument: metric unit folding (foldTargetUnit / §5.10/§5.12/§5.13)", () => {
  it("folds a ramp Load's nested unit up to Load.unit, and wraps a bare-scalar Intensity value in {absolute}", () => {
    const recs = norm({
      id: "w1",
      recordType: "WorkUnit",
      scoring: "reps",
      subject: "u1",
      performance: {
        reps: 5,
        load: { value: { ramp: { from: { value: 100 }, to: { value: 120 }, unit: "kg" } } },
        intensity: [{ dimension: "power", value: 250, unit: "W" }],
      },
    });
    const p = by(recs, "w1")?.performance;
    // §5.12: the unit moves up to the sibling Load.unit; the ramp's directional from/to are untouched.
    expect(p.load.unit).toBe("kg");
    expect(p.load.value.ramp.unit, "the inner ramp unit folds up, not left nested").toBeUndefined();
    expect(p.load.value.ramp.from).toEqual({ value: { coefficient: "1", exponent: "2" } }); // 100 = 1e2
    expect(p.load.value.ramp.to).toEqual({ value: { coefficient: "12", exponent: "1" } }); // 120 = 12e1
    // §5.13: a bare-scalar Intensity value wraps to {absolute:{value}}; the sibling unit stays put.
    expect(p.intensity[0].value).toEqual({ absolute: { value: { coefficient: "25", exponent: "1" } } }); // 250 = 25e1
    expect(p.intensity[0].unit).toBe("W");
  });
});

describe("equivalent (EQUIVALENCE.md)", () => {
  const nested: NormalizeInput = {
    id: "s1",
    recordType: "Session",
    subject: "u1",
    startTime: "2026-01-01T10:00:00Z",
    workUnits: [{ id: "w1", recordType: "WorkUnit", scoring: "reps", performance: { reps: 5 } }],
  };
  const flattened: NormalizeInput = [
    { id: "s1", recordType: "Session", subject: "u1", startTime: "2026-01-01T10:00:00Z", status: "active" },
    {
      id: "w1",
      recordType: "WorkUnit",
      scoring: "reps",
      subject: "u1",
      startTime: "2026-01-01T10:00:00Z",
      status: "active",
      performance: { reps: 5 },
      links: [{ type: "partOf", ref: "s1" }],
    },
  ];

  it("a nested document and its hand-flattened form are equivalent", () => {
    expect(equivalent(nested, flattened)).toBe(true);
  });

  it("two documents differing only in set-array (links) order are equivalent (step 9 ordering)", () => {
    const a: NormalizeInput = {
      id: "s1",
      recordType: "Session",
      subject: "u1",
      links: [
        { type: "partOf", ref: "a" },
        { type: "measuredBy", ref: "b" },
      ],
    };
    const b: NormalizeInput = {
      id: "s1",
      recordType: "Session",
      subject: "u1",
      links: [
        { type: "measuredBy", ref: "b" },
        { type: "partOf", ref: "a" },
      ],
    };
    expect(equivalent(a, b)).toBe(true);
  });

  it("two genuinely different documents are NOT equivalent", () => {
    expect(
      equivalent(
        { id: "s1", recordType: "Session", subject: "u1" },
        { id: "s1", recordType: "Session", subject: "u2" },
      ),
    ).toBe(false);
  });
});
