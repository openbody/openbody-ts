// Unit checks for §8.3 step-1 lossless number canonicalization (B1 / OB-9).
// Proves parseLossless preserves exact decimal text where JSON.parse (float64) loses it.
import assert from "node:assert/strict";
import { parseLossless, LosslessNumber } from "../src/parse.js";
import { canonNumber, deepCanon } from "../src/canonical.js";
import { normalizeDocument } from "../src/normalize.js";

let n = 0;
const check = (label: string, fn: () => void) => {
  fn();
  n++;
  console.log(`  ok   ${label}`);
};

// --- parseLossless preserves exact source text ---
check("parseLossless keeps >2^53 integer text", () => {
  const v = parseLossless("9007199254740993") as LosslessNumber; // 2^53 + 1
  assert.ok(v instanceof LosslessNumber);
  assert.equal(v.value, "9007199254740993");
  // JSON.parse cannot: it rounds to 2^53.
  assert.equal(JSON.parse("9007199254740993"), 9007199254740992);
});

check("parseLossless keeps high-precision decimal text", () => {
  const v = parseLossless("1.00000000000000001") as LosslessNumber;
  assert.equal(v.value, "1.00000000000000001");
  assert.equal(JSON.parse("1.00000000000000001"), 1); // float64 collapses to 1
});

// --- canonNumber: spec examples (§8.3 step 1) ---
check("canonNumber 37.4220 -> 37422e-3", () => {
  assert.deepEqual(canonNumber(new LosslessNumber("37.4220")), { coefficient: "37422", exponent: "-3" });
});
check("canonNumber 80.5 -> 805e-1", () => {
  assert.deepEqual(canonNumber(new LosslessNumber("80.5")), { coefficient: "805", exponent: "-1" });
});
check("canonNumber 72.0 -> 72e0; zero -> 0e0", () => {
  assert.deepEqual(canonNumber(new LosslessNumber("72.0")), { coefficient: "72", exponent: "0" });
  assert.deepEqual(canonNumber(new LosslessNumber("0")), { coefficient: "0", exponent: "0" });
});

// --- the lossless path differs from the float64 path on hard values ---
check("lossless canon differs from float64 canon (precision preserved)", () => {
  const lossless = canonNumber(new LosslessNumber("1.00000000000000001"));
  const float64 = canonNumber(JSON.parse("1.00000000000000001") as number);
  assert.equal(lossless.coefficient, "100000000000000001");
  assert.equal(lossless.exponent, "-17");
  assert.equal(float64.coefficient, "1"); // lossy — the whole reason for B1
  assert.notDeepEqual(lossless, float64);
});

// --- end-to-end: a high-precision quantity survives normalization exactly ---
check("normalizeDocument preserves exact quantity through canonical bytes", () => {
  // High-precision quantity authored as raw JSON text (a JS number literal would lose it).
  const doc = parseLossless(`{
    "recordType": "Measurement",
    "id": "m-1",
    "measurementType": "body.mass",
    "subject": "u-1",
    "asOf": "2026-01-01T00:00:00Z",
    "quantity": 80.123456789012345678
  }`);
  const [bytes] = normalizeDocument(doc as any);
  assert.ok(bytes.includes('"coefficient":"80123456789012345678"'), bytes);
  assert.ok(bytes.includes('"exponent":"-18"'), bytes);
});

// --- deepCanon walks LosslessNumber leaves ---
check("deepCanon converts nested LosslessNumber", () => {
  const out = deepCanon({ a: new LosslessNumber("12.50"), b: [new LosslessNumber("100")] }) as any;
  assert.deepEqual(out.a, { coefficient: "125", exponent: "-1" });
  assert.deepEqual(out.b[0], { coefficient: "1", exponent: "2" });
});

console.log(`\n${n} lossless checks passed`);
