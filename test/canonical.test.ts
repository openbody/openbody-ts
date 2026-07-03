// §8.3 step-1 canonicalization (canonNumber/deepCanon) + end-to-end lossless
// normalization — ported from scripts/test-lossless.ts (B1 / OB-9).
import { describe, expect, it } from "vitest";
import { canonNumber, canonTimestamp, deepCanon } from "../src/canonical.js";
import { normalizeDocument } from "../src/normalize.js";
import { LosslessNumber, parseLossless } from "../src/parse.js";

describe("canonNumber (spec examples, §8.3 step 1)", () => {
  it("37.4220 -> 37422e-3", () => {
    expect(canonNumber(new LosslessNumber("37.4220"))).toEqual({ coefficient: "37422", exponent: "-3" });
  });
  it("80.5 -> 805e-1", () => {
    expect(canonNumber(new LosslessNumber("80.5"))).toEqual({ coefficient: "805", exponent: "-1" });
  });
  it("72.0 -> 72e0; zero -> 0e0", () => {
    expect(canonNumber(new LosslessNumber("72.0"))).toEqual({ coefficient: "72", exponent: "0" });
    expect(canonNumber(new LosslessNumber("0"))).toEqual({ coefficient: "0", exponent: "0" });
  });
});

describe("lossless vs float64", () => {
  it("lossless canon differs from float64 canon (precision preserved)", () => {
    const lossless = canonNumber(new LosslessNumber("1.00000000000000001"));
    const float64 = canonNumber(JSON.parse("1.00000000000000001") as number);
    expect(lossless.coefficient).toBe("100000000000000001");
    expect(lossless.exponent).toBe("-17");
    expect(float64.coefficient).toBe("1"); // lossy — the whole reason for B1
    expect(lossless).not.toEqual(float64);
  });
});

describe("normalizeDocument end-to-end", () => {
  it("preserves exact quantity through canonical bytes", () => {
    // High-precision quantity authored as raw JSON text (a JS number literal would lose it).
    const doc = parseLossless(`{
      "recordType": "Measurement",
      "id": "m-1",
      "measurementType": "body.mass",
      "subject": "u-1",
      "asOf": "2026-01-01T00:00:00Z",
      "quantity": 80.123456789012345678
    }`);
    const [bytes = ""] = normalizeDocument(doc as any);
    expect(bytes).toContain('"coefficient":"80123456789012345678"');
    expect(bytes).toContain('"exponent":"-18"');
  });
});

describe("deepCanon", () => {
  it("converts nested LosslessNumber", () => {
    const out = deepCanon({ a: new LosslessNumber("12.50"), b: [new LosslessNumber("100")] }) as any;
    expect(out.a).toEqual({ coefficient: "125", exponent: "-1" });
    expect(out.b[0]).toEqual({ coefficient: "1", exponent: "2" });
  });

  // §8.3 step 1: fixed-point-shaped objects are numeric ONLY outside extension/script.
  it("fixed-point object collapses in a numeric field but stays structural in extension", () => {
    // numeric-typed position: {coefficient:720, exponent:-1} = 72 → fixed-point {72, 0}
    const numeric = deepCanon({ value: { coefficient: 720, exponent: -1 } }) as any;
    expect(numeric.value).toEqual({ coefficient: "72", exponent: "0" });
    // inside extension: NOT re-read — a plain object whose number members canonicalize
    // independently (720 → 72×10¹; -1 → -1×10⁰).
    const opaque = deepCanon({ extension: { "x:f": { coefficient: 720, exponent: -1 } } }) as any;
    expect(opaque.extension["x:f"]).toEqual({
      coefficient: { coefficient: "72", exponent: "1" },
      exponent: { coefficient: "-1", exponent: "0" },
    });
  });
});

describe("canonTimestamp (EQUIVALENCE.md step 1)", () => {
  it("re-spells zero offsets and trailing-zero fractions", () => {
    expect(canonTimestamp("2026-01-01T10:00:00+00:00")).toBe("2026-01-01T10:00:00Z");
    expect(canonTimestamp("2026-01-01t10:00:00.500z")).toBe("2026-01-01T10:00:00.5Z");
    expect(canonTimestamp("2026-01-01T10:00:00.000Z")).toBe("2026-01-01T10:00:00Z");
    expect(canonTimestamp("2026-01-01T10:00:00.120-07:00")).toBe("2026-01-01T10:00:00.12-07:00");
  });
});
