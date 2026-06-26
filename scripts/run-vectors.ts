// Conformance vector runner: loads the standard's vectors and checks each assertion
// against this implementation. This is what turns the vectors from "asserted" into
// "verified" and pins the §8.3 canonical bytes.
import fs from "node:fs";
import path from "node:path";
import { normalizeDocument, equivalent } from "../src/normalize.js";
import { validate, standardDir } from "../src/validate.js";
import { parseLossless } from "../src/parse.js";

const vdir = path.join(standardDir, "conformance/vectors");
const files = fs.readdirSync(vdir).filter((f) => f.endsWith(".json") && f !== "index.json").sort();

let pass = 0;
let fail = 0;
const fails: string[] = [];

function ok(name: string) { pass++; console.log(`  ok   ${name}`); }
function bad(name: string, why: string) { fail++; fails.push(`${name}: ${why}`); console.log(`  FAIL ${name} — ${why}`); }

function allValid(doc: any): string | null {
  for (const r of Array.isArray(doc) ? doc : [doc]) {
    const v = validate(r);
    if (!v.valid) return `schema: ${v.errors}`;
  }
  return null;
}

// idempotence: re-normalizing the canonical output yields itself (round-trip proxy).
function idempotent(doc: any): boolean {
  const n1 = normalizeDocument(doc);
  const parsed = n1.map((s) => JSON.parse(s));
  const n2 = normalizeDocument(parsed);
  return n1.length === n2.length && n1.every((s, i) => s === n2[i]);
}

console.log(`OpenBody-TS conformance run (standard: ${standardDir})\n`);
for (const f of files) {
  const text = fs.readFileSync(path.join(vdir, f), "utf8");
  const v = JSON.parse(text);              // plain parse: metadata + schema validation
  const vL = parseLossless(text) as any;   // lossless parse: documents for §8.3 normalization
  const name = `${v.name} [${v.kind}]`;
  try {
    if (v.kind === "valid") {
      const e = allValid(v.record);
      if (e) { bad(name, e); continue; }
      normalizeDocument(vL.record);
      if (!idempotent(vL.record)) { bad(name, "normalization not idempotent"); continue; }
      ok(name);
    } else if (v.kind === "invalid") {
      const e = allValid(v.record);
      if (e) ok(name); else bad(name, "expected schema rejection but it validated");
    } else if (v.kind === "equivalent") {
      const ea = allValid(v.a), eb = allValid(v.b);
      if (ea) { bad(name, `a ${ea}`); continue; }
      if (eb) { bad(name, `b ${eb}`); continue; }
      if (equivalent(vL.a, vL.b)) ok(name);
      else {
        bad(name, "a and b are NOT equivalent");
        console.log("       a:", normalizeDocument(vL.a));
        console.log("       b:", normalizeDocument(vL.b));
      }
    } else if (v.kind === "normalization") {
      const recs = normalizeDocument(vL.input);
      if (Array.isArray(v.expected)) {
        const match = recs.length === v.expected.length && recs.every((s, i) => s === v.expected[i]);
        if (match) ok(`${name} (${recs.length} records, exact match)`);
        else {
          bad(name, "normalized output != pinned expected");
          console.log("       got:     ", recs);
          console.log("       expected:", v.expected);
        }
      } else {
        ok(`${name} (${recs.length} canonical records; no pinned expected)`);
        for (const r of recs) console.log("       ·", r);
      }
    } else {
      bad(name, `unknown kind ${v.kind}`);
    }
  } catch (err) {
    bad(name, `threw: ${(err as Error).message}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
