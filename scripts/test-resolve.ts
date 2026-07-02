// Resolver unit tests (src/resolve.ts): the §6.5 producer-side matching ladder —
// exact alias, canonical-id passthrough, normalized/token-sorted matching,
// curated-null and unknown-name opaque fallbacks — plus schema validation of
// every ExerciseRef shape the resolver emits, full coverage of the example exports, and
// the outbound reverse lookup. Run via `npm run resolve` (part of `npm test`).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/schema-loader-node.js";
import { resolveExerciseRef, sourceNameForId } from "../src/resolve.js";
import { parseCsv } from "../src/mappers/index.js";

const ex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples");
const read = (p: string) => fs.readFileSync(path.join(ex, p), "utf8");

let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const j = (v: unknown) => JSON.stringify(v);

// ---- rung 1: exact per-app alias match (id + lossless opaque) ----
{
  const r = resolveExerciseRef("Bench Press (Barbell)", { source: "hevy" });
  check("hevy exact alias", j(r) === j({ id: "bench-press.barbell.flat", opaque: "Bench Press (Barbell)" }), j(r));
}
{
  const r = resolveExerciseRef("Bench Press (Barbell)", { source: "strong" });
  check("strong exact alias", j(r) === j({ id: "bench-press.barbell.flat", opaque: "Bench Press (Barbell)" }), j(r));
}
// The OB-65 marquee case: Hevy and Strong spellings land on the same canonical id.
{
  const a = resolveExerciseRef("Bench Press (Barbell)", { source: "hevy" });
  const b = resolveExerciseRef("Barbell Bench Press", { source: "strong" });
  check("hevy/strong spellings converge", a.id === "bench-press.barbell.flat" && a.id === b.id, `${j(a)} vs ${j(b)}`);
}
// Curated null = known unmappable: opaque only, and fuzzy rungs must NOT override it.
{
  const r = resolveExerciseRef("Bulgarian Split Squat", { source: "hevy" });
  check("curated null → opaque only", j(r) === j({ opaque: "Bulgarian Split Squat" }), j(r));
}

// ---- rung 2: canonical-id passthrough ----
{
  const r = resolveExerciseRef("squat.barbell.high-bar");
  check("canonical id passthrough (no opaque)", j(r) === j({ id: "squat.barbell.high-bar" }), j(r));
}

// ---- rung 3: normalized matches (work without any source table too) ----
{
  const r = resolveExerciseRef("  BARBELL back squat!! ");
  check("case/punctuation-insensitive registry-name match", j(r) === j({ id: "squat.barbell.high-bar", opaque: "  BARBELL back squat!! " }), j(r));
}
{
  // Token-sorted: "Barbell Bench Press" (no strong table consulted) ↔ hevy alias
  // "Bench Press (Barbell)" both sort to "barbell bench press".
  const r = resolveExerciseRef("Press Bench (Barbell)");
  check("token-sorted match", r.id === "bench-press.barbell.flat" && r.opaque === "Press Bench (Barbell)", j(r));
}
{
  // A curated alias-table entry feeds the normalized index even without opts.source.
  const r = resolveExerciseRef("Face Pull (Rope)");
  check("alias-table-backed normalized match", r.id === "face-pull" && r.opaque === "Face Pull (Rope)", j(r));
}
{
  // There is deliberately NO discard-the-parenthetical rung: an uncurated name whose
  // qualifier is load-bearing MUST NOT false-match the unqualified movement — it stays
  // opaque until someone curates an alias-table entry (see src/resolve.ts header).
  const r = resolveExerciseRef("Pull Up (Weighted Vest)");
  check("load-bearing qualifier never dropped → opaque", j(r) === j({ opaque: "Pull Up (Weighted Vest)" }), j(r));
}

// ---- rung 4: opaque fallback ----
{
  const r = resolveExerciseRef("Quantum Flux Press 3000");
  check("unknown name → lossless opaque", j(r) === j({ opaque: "Quantum Flux Press 3000" }), j(r));
}

// ---- every ExerciseRef shape the resolver emits validates against the schema ----
function exercise(ref: unknown) {
  return {
    id: "ex-1", recordType: "Exercise", exerciseRef: ref,
    workUnits: [{ id: "wu-1", recordType: "WorkUnit", scoring: "reps", performance: { reps: 5 } }],
  };
}
for (const [label, ref] of [
  ["id + opaque co-present", resolveExerciseRef("Bench Press (Barbell)", { source: "hevy" })],
  ["id only", resolveExerciseRef("squat.barbell.high-bar")],
  ["opaque only", resolveExerciseRef("Quantum Flux Press 3000")],
] as const) {
  const v = validate(exercise(ref));
  check(`schema accepts ${label}`, v.valid, v.errors ?? undefined);
}

// ---- alias-table coverage: every exercise name in the example exports has a curated
// entry in its app's alias table (mapped OR explicitly null — never merely unknown) ----
{
  const xwalk = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../vendor/crosswalk.json"), "utf8"));
  for (const [app, file, col] of [
    ["hevy", "hevy/hevy-sample.csv", "exercise_title"],
    ["strong", "strong/strong-sample.csv", "Exercise Name"],
  ] as const) {
    const names = [...new Set(parseCsv(read(file)).map((r) => r[col]))];
    const missing = names.filter((n) => !(n in xwalk.aliases[app]));
    const resolved = names.filter((n) => resolveExerciseRef(n, { source: app }).id !== undefined);
    check(`${app} example: all ${names.length} names curated in alias table (${resolved.length} resolve to canonical ids)`,
      missing.length === 0, `missing from crosswalk/${app}.json: ${missing.join(", ")}`);
  }
}

// ---- determinism: same input, same output (indexes are order-independent) ----
{
  const a = j(resolveExerciseRef("Lat Pulldown (Cable)", { source: "hevy" }));
  const b = j(resolveExerciseRef("Lat Pulldown (Cable)", { source: "hevy" }));
  check("deterministic", a === b);
}

// ---- outbound reverse lookup ----
{
  const n = sourceNameForId("bench-press.barbell.flat", "strong");
  check("sourceNameForId finds a strong alias", n !== undefined && resolveExerciseRef(n!, { source: "strong" }).id === "bench-press.barbell.flat", n);
  check("sourceNameForId unknown id → undefined", sourceNameForId("no-such.id", "strong") === undefined);
  check("sourceNameForId unknown source → undefined", sourceNameForId("bench-press.barbell.flat", "nope") === undefined);
}

console.log(fail ? `\n${fail} resolver test(s) FAILED` : "\nall resolver tests pass");
if (fail) process.exit(1);
