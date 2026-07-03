// Node-only conformance-vector running logic — NOT re-exported from `src/index.ts`
// (same posture as `schema-loader-node.ts`: node:fs in the module graph). Shared by
// the CLI wrapper (`scripts/run-vectors.ts`, referenced by docs/`npm run vectors`)
// and the vitest suite (`test/conformance.test.ts`) so the assertion semantics can
// never drift between the two.
//
// This is what turns the standard's vectors from "asserted" into "verified" and pins
// the §8.3 canonical bytes: loads each vector from the sibling `openbody` checkout
// (OPENBODY_STANDARD-aware via `standardDir`) and checks its assertion against this
// implementation.
import fs from "node:fs";
import path from "node:path";
import { equivalent, type NormalizeInput, normalizeDocument } from "./normalize.js";
import { parseLossless } from "./parse.js";
import { standardDir, validate } from "./schema-loader-node.js";

export { standardDir };

export interface VectorFile {
  /** Which suite the file belongs to. */
  label: "vectors" | "corpus";
  dir: string;
  file: string;
}

// The minimum-core conformance vectors plus the extended activity-coverage corpus
// (SPEC §8.3). The corpus is coverage validation, not a conformance bar — but its
// records must still validate and round-trip, so both run through the same checks.
export function discoverVectorFiles(): VectorFile[] {
  const dirs: { label: VectorFile["label"]; path: string }[] = [
    { label: "vectors", path: path.join(standardDir, "conformance/vectors") },
    { label: "corpus", path: path.join(standardDir, "conformance/corpus") },
  ];
  return dirs.flatMap((d) =>
    fs.existsSync(d.path)
      ? fs
          .readdirSync(d.path)
          .filter((f) => f.endsWith(".json") && f !== "index.json")
          .sort()
          .map((f) => ({ label: d.label, dir: d.path, file: f }))
      : [],
  );
}

export interface VectorOutcome {
  /** `<vector name> [<kind>]` — the display name the CLI has always printed. */
  name: string;
  ok: boolean;
  /** ok: optional extra detail; FAIL: the reason (may be multi-line). */
  detail?: string;
}

function allValid(doc: unknown): string | null {
  for (const r of Array.isArray(doc) ? doc : [doc]) {
    const v = validate(r);
    if (!v.valid) return `schema: ${v.errors}`;
  }
  return null;
}

// idempotence: re-normalizing the canonical output yields itself (round-trip proxy).
function idempotent(doc: NormalizeInput): boolean {
  const n1 = normalizeDocument(doc);
  const parsed = n1.map((s) => JSON.parse(s));
  const n2 = normalizeDocument(parsed);
  return n1.length === n2.length && n1.every((s, i) => s === n2[i]);
}

/** Run one vector file's assertion against this implementation. */
export function runVectorFile(dir: string, file: string): VectorOutcome {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  const v = JSON.parse(text); // plain parse: metadata + schema validation
  // lossless parse: documents for §8.3 normalization (LosslessNumber-bearing trees).
  // Which of record/a/b/input is present depends on v.kind — each branch reads only its own.
  const vL = parseLossless(text) as {
    record: NormalizeInput;
    a: NormalizeInput;
    b: NormalizeInput;
    input: NormalizeInput;
  };
  const name = `${v.name} [${v.kind}]`;
  const ok = (detail?: string): VectorOutcome => ({ name, ok: true, ...(detail ? { detail } : {}) });
  const bad = (why: string): VectorOutcome => ({ name, ok: false, detail: why });
  try {
    if (v.kind === "valid") {
      const e = allValid(v.record);
      if (e) return bad(e);
      normalizeDocument(vL.record);
      if (!idempotent(vL.record)) return bad("normalization not idempotent");
      return ok();
    } else if (v.kind === "invalid") {
      const e = allValid(v.record);
      return e ? ok() : bad("expected schema rejection but it validated");
    } else if (v.kind === "equivalent") {
      const ea = allValid(v.a),
        eb = allValid(v.b);
      if (ea) return bad(`a ${ea}`);
      if (eb) return bad(`b ${eb}`);
      if (equivalent(vL.a, vL.b)) return ok();
      return bad(
        [
          "a and b are NOT equivalent",
          `  a: ${JSON.stringify(normalizeDocument(vL.a))}`,
          `  b: ${JSON.stringify(normalizeDocument(vL.b))}`,
        ].join("\n"),
      );
    } else if (v.kind === "inequivalent") {
      const ea = allValid(v.a),
        eb = allValid(v.b);
      if (ea) return bad(`a ${ea}`);
      if (eb) return bad(`b ${eb}`);
      if (!equivalent(vL.a, vL.b)) return ok();
      return bad("a and b normalized EQUAL but must stay distinct");
    } else if (v.kind === "normalization") {
      const recs = normalizeDocument(vL.input);
      if (Array.isArray(v.expected)) {
        const match = recs.length === v.expected.length && recs.every((s, i) => s === v.expected[i]);
        if (match) return ok(`(${recs.length} records, exact match)`);
        return bad(
          [
            "normalized output != pinned expected",
            `  got:      ${JSON.stringify(recs)}`,
            `  expected: ${JSON.stringify(v.expected)}`,
          ].join("\n"),
        );
      }
      return ok(
        `(${recs.length} canonical records; no pinned expected)\n${recs.map((r) => `       · ${r}`).join("\n")}`,
      );
    }
    return bad(`unknown kind ${v.kind}`);
  } catch (err) {
    return bad(`threw: ${(err as Error).message}`);
  }
}
