// Resolver unit tests (src/resolve.ts): the §6.5 producer-side matching ladder —
// exact alias, canonical-id passthrough, normalized/token-sorted matching,
// curated-null and unknown-name opaque fallbacks — plus schema validation of
// every ExerciseRef shape the resolver emits, full coverage of the example exports,
// and the outbound reverse lookup. Ported from scripts/test-resolve.ts.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/mappers/csv.js";
import { resolveExerciseRef, sourceNameForId } from "../src/resolve.js";
import { readExample, repoRoot, validate } from "./helpers.js";

describe("rung 1: exact per-app alias match (id + lossless opaque)", () => {
  it("hevy exact alias", () => {
    expect(resolveExerciseRef("Bench Press (Barbell)", { source: "hevy" })).toEqual({
      id: "bench-press.barbell.flat",
      opaque: "Bench Press (Barbell)",
    });
  });
  it("strong exact alias", () => {
    expect(resolveExerciseRef("Bench Press (Barbell)", { source: "strong" })).toEqual({
      id: "bench-press.barbell.flat",
      opaque: "Bench Press (Barbell)",
    });
  });
  // The OB-65 marquee case: Hevy and Strong spellings land on the same canonical id.
  it("hevy/strong spellings converge", () => {
    const a = resolveExerciseRef("Bench Press (Barbell)", { source: "hevy" });
    const b = resolveExerciseRef("Barbell Bench Press", { source: "strong" });
    expect(a.id).toBe("bench-press.barbell.flat");
    expect(b.id).toBe(a.id);
  });
  // Curated null = known unmappable: opaque only, and fuzzy rungs must NOT override it.
  it("curated null → opaque only", () => {
    expect(resolveExerciseRef("Bulgarian Split Squat", { source: "hevy" })).toEqual({
      opaque: "Bulgarian Split Squat",
    });
  });
});

describe("rung 2: canonical-id passthrough", () => {
  it("canonical id passthrough (no opaque)", () => {
    expect(resolveExerciseRef("squat.barbell.high-bar")).toEqual({ id: "squat.barbell.high-bar" });
  });
});

describe("rung 3: normalized matches (work without any source table too)", () => {
  it("case/punctuation-insensitive registry-name match", () => {
    expect(resolveExerciseRef("  BARBELL back squat!! ")).toEqual({
      id: "squat.barbell.high-bar",
      opaque: "  BARBELL back squat!! ",
    });
  });
  // Token-sorted: "Barbell Bench Press" (no strong table consulted) ↔ hevy alias
  // "Bench Press (Barbell)" both sort to "barbell bench press".
  it("token-sorted match", () => {
    const r = resolveExerciseRef("Press Bench (Barbell)");
    expect(r.id).toBe("bench-press.barbell.flat");
    expect(r.opaque).toBe("Press Bench (Barbell)");
  });
  // A curated alias-table entry feeds the normalized index even without opts.source.
  it("alias-table-backed normalized match", () => {
    const r = resolveExerciseRef("Face Pull (Rope)");
    expect(r.id).toBe("face-pull");
    expect(r.opaque).toBe("Face Pull (Rope)");
  });
  // There is deliberately NO discard-the-parenthetical rung: an uncurated name whose
  // qualifier is load-bearing MUST NOT false-match the unqualified movement — it stays
  // opaque until someone curates an alias-table entry (see src/resolve.ts header).
  it("load-bearing qualifier never dropped → opaque", () => {
    expect(resolveExerciseRef("Pull Up (Weighted Vest)")).toEqual({ opaque: "Pull Up (Weighted Vest)" });
  });
});

describe("rung 4: opaque fallback", () => {
  it("unknown name → lossless opaque", () => {
    expect(resolveExerciseRef("Quantum Flux Press 3000")).toEqual({ opaque: "Quantum Flux Press 3000" });
  });
});

// The AMBIGUOUS rung (§6.5): a normalized key claimed by two DIFFERENT canonical ids never
// matches — resolution falls through to opaque, deterministically, regardless of table order.
// "Seated Calf Raise" is a real collision in the vendored crosswalk (machine vs barbell).
describe("rung 3: an ambiguous normalized key never matches (falls through to opaque)", () => {
  const xwalk = JSON.parse(fs.readFileSync(path.join(repoRoot, "vendor/crosswalk.json"), "utf8")) as {
    registry: { id: string }[];
  };
  const ids = new Set(xwalk.registry.map((e) => e.id));

  it('"Seated Calf Raise" is genuinely ambiguous (two registry ids) yet resolves opaque-only without a source', () => {
    // Precondition: both colliding ids really are in the registry — so this is ambiguity, not absence.
    expect(ids.has("calf-raise.seated.machine")).toBe(true);
    expect(ids.has("calf-raise.seated.barbell")).toBe(true);
    // No source ⇒ rung 1 is skipped; the shared normalized key is AMBIGUOUS ⇒ opaque-only.
    expect(resolveExerciseRef("Seated Calf Raise")).toEqual({ opaque: "Seated Calf Raise" });
  });

  it("a curated per-app alias (rung 1) still overrides the ambiguity", () => {
    expect(resolveExerciseRef("Seated Calf Raise", { source: "hevy" })).toEqual({
      id: "calf-raise.seated.machine",
      opaque: "Seated Calf Raise",
    });
  });
});

// The rung-3 `id === name` branch (opaque omitted → `{ id }`) is shadowed by rung-2 canonical-id
// passthrough: every id the normalized index can return is a registry id, so any input equal to
// it is caught by rung 2 first. Rung 2 already pins that opaque-omitted `{ id }` shape below,
// so the observable contract is covered even though the rung-3 branch is unreachable via the API.

describe("every ExerciseRef shape the resolver emits validates against the schema", () => {
  const exercise = (ref: unknown) => ({
    id: "ex-1",
    recordType: "Exercise",
    exerciseRef: ref,
    workUnits: [{ id: "wu-1", recordType: "WorkUnit", scoring: "reps", performance: { reps: 5 } }],
  });
  it.each([
    ["id + opaque co-present", resolveExerciseRef("Bench Press (Barbell)", { source: "hevy" })],
    ["id only", resolveExerciseRef("squat.barbell.high-bar")],
    ["opaque only", resolveExerciseRef("Quantum Flux Press 3000")],
  ] as const)("schema accepts %s", (_, ref) => {
    const v = validate(exercise(ref));
    expect(v.valid, v.errors ?? undefined).toBe(true);
  });
});

// Alias-table coverage: every exercise name in the example exports has a curated
// entry in its app's alias table (mapped OR explicitly null — never merely unknown).
describe("alias-table coverage of the example exports", () => {
  const xwalk = JSON.parse(fs.readFileSync(path.join(repoRoot, "vendor/crosswalk.json"), "utf8"));
  it.each([
    ["hevy", "hevy/hevy-sample.csv", "exercise_title"],
    ["strong", "strong/strong-sample.csv", "Exercise Name"],
  ] as const)("%s example: all names curated in the alias table", (app, file, col) => {
    const names = [...new Set(parseCsv(readExample(file)).map((r) => r[col] ?? ""))];
    const missing = names.filter((n) => !(n in xwalk.aliases[app]));
    expect(missing, `missing from crosswalk/${app}.json: ${missing.join(", ")}`).toEqual([]);
    // and at least some resolve to canonical ids (the resolver is actually wired in)
    const resolved = names.filter((n) => resolveExerciseRef(n, { source: app }).id !== undefined);
    expect(resolved.length).toBeGreaterThan(0);
  });
});

describe("determinism + outbound reverse lookup", () => {
  it("same input, same output (indexes are order-independent)", () => {
    expect(resolveExerciseRef("Lat Pulldown (Cable)", { source: "hevy" })).toEqual(
      resolveExerciseRef("Lat Pulldown (Cable)", { source: "hevy" }),
    );
  });
  it("sourceNameForId finds a strong alias", () => {
    const n = sourceNameForId("bench-press.barbell.flat", "strong");
    expect(n).toBeDefined();
    expect(resolveExerciseRef(n ?? "", { source: "strong" }).id).toBe("bench-press.barbell.flat");
  });
  it("sourceNameForId unknown id → undefined", () => {
    expect(sourceNameForId("no-such.id", "strong")).toBeUndefined();
  });
  it("sourceNameForId unknown source → undefined", () => {
    expect(sourceNameForId("bench-press.barbell.flat", "nope")).toBeUndefined();
  });
});
