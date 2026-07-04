// Property-based tests for the canonicalization / lossless-parse primitives — the
// invariants the equivalence oracle (SPEC §8.3 / EQUIVALENCE.md) actually relies on,
// exercised over generated inputs rather than the hand-picked examples in
// canonical.test.ts / parse.test.ts. fast-check runs each property ~100× by default.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalString, canonNumber, canonTimestamp, deepCanon } from "../src/canonical.js";
import { NormalizeError } from "../src/errors.js";
import { LosslessNumber, parseLossless } from "../src/parse.js";

// Arbitrary JSON documents with ordinary (non-prototype-magic) keys. Excluding "__proto__"
// and the inherited Object.prototype names keeps these broad structural properties focused on
// the canonicalization invariants — prototype-key handling is a distinct concern with its own
// dedicated test in parse.test.ts, and injecting those keys here would probe how deepCanon /
// JSON.stringify treat magic keys rather than the invariant under test.
const ordinaryKey = fc.string({ minLength: 1 }).filter((k) => k !== "__proto__" && !(k in Object.prototype));
const jsonDocument = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string(),
    fc.array(tie("value"), { maxLength: 6 }),
    fc.dictionary(ordinaryKey, tie("value"), { maxKeys: 6 }),
  ),
})).value;

// A fixed-point value as its exact (coefficient, exponent) parts — the exact rationals
// EQUIVALENCE.md step 1 reduces numbers to, generated without touching float64.
const fixedPointValue = fc.record({
  coefficient: fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }),
  exponent: fc.integer({ min: -15, max: 15 }),
});

describe("canonNumber (EQUIVALENCE.md step 1 — numbers)", () => {
  it("collapses every decimal spelling of one value to a single canonical fixed point", () => {
    // coefficient × 10^k with exponent − k denotes the identical rational — canonicalization
    // must erase the difference. Exact BigInt arithmetic, so no float rounding anywhere.
    fc.assert(
      fc.property(fixedPointValue, fc.nat({ max: 8 }), ({ coefficient, exponent }, k) => {
        const canonical = canonNumber({ coefficient: String(coefficient), exponent: String(exponent) });
        const scaled = canonNumber({
          coefficient: String(coefficient * 10n ** BigInt(k)),
          exponent: String(exponent - k),
        });
        expect(scaled).toEqual(canonical);
      }),
    );
  });

  it("reduces to lowest terms and is idempotent", () => {
    fc.assert(
      fc.property(fixedPointValue, ({ coefficient, exponent }) => {
        const fp = canonNumber({ coefficient: String(coefficient), exponent: String(exponent) });
        // Lowest terms: the coefficient carries no trailing zero (they migrate to the exponent),
        // the sole exception being the canonical zero.
        if (fp.coefficient === "0") expect(fp).toEqual({ coefficient: "0", exponent: "0" });
        else expect(BigInt(fp.coefficient) % 10n === 0n).toBe(false);
        // Feeding the canonical form back is a fixed point of the reduction.
        expect(canonNumber(fp)).toEqual(fp);
      }),
    );
  });

  it("interprets a LosslessNumber from its decimal text, agreeing with the fixed-point path", () => {
    fc.assert(
      fc.property(fixedPointValue, ({ coefficient, exponent }) => {
        // "<coefficient>e<exponent>" is a valid JSON number spelling of the same value.
        const viaText = canonNumber(new LosslessNumber(`${coefficient}e${exponent}`));
        const viaParts = canonNumber({ coefficient: String(coefficient), exponent: String(exponent) });
        expect(viaText).toEqual(viaParts);
      }),
    );
  });
});

// A valid RFC 3339 timestamp with varied offset/fraction spellings — the cases
// canonTimestamp normalizes (zero offset → Z, trailing-zero fractions trimmed, uppercased).
const two = (n: number): string => String(n).padStart(2, "0");
const timestamp = fc
  .record({
    year: fc.integer({ min: 1970, max: 2999 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
    second: fc.integer({ min: 0, max: 59 }),
    fraction: fc.constantFrom("", ".0", ".5", ".500", ".123", ".120", ".000000"),
    offset: fc.constantFrom("Z", "z", "+00:00", "-00:00", "+05:30", "-07:00", "+14:00"),
  })
  .map(
    (t) =>
      `${t.year}-${two(t.month)}-${two(t.day)}T${two(t.hour)}:${two(t.minute)}:${two(t.second)}${t.fraction}${t.offset}`,
  );

describe("canonTimestamp (EQUIVALENCE.md step 1 — timestamps)", () => {
  it("is idempotent", () => {
    fc.assert(
      fc.property(timestamp, (s) => {
        const once = canonTimestamp(s);
        expect(canonTimestamp(once)).toBe(once);
      }),
    );
  });

  it("folds any zero UTC offset to Z and uppercases the spelling", () => {
    fc.assert(
      fc.property(timestamp, (s) => {
        const out = canonTimestamp(s);
        expect(out).toBe(out.toUpperCase()); // T and Z (and any offset) are uppercase
        expect(/[+-]00:00$/.test(out)).toBe(false); // no zero offset survives — it becomes Z
      }),
    );
  });
});

describe("deepCanon / canonicalString (EQUIVALENCE.md step 1 + RFC 8785)", () => {
  it("is idempotent over arbitrary JSON", () => {
    fc.assert(
      fc.property(jsonDocument, (value) => {
        let once: unknown;
        try {
          once = deepCanon(value);
        } catch (e) {
          // A {coefficient, exponent} object with non-integer parts is correctly rejected
          // (NormalizeError) — out of scope for the idempotence claim.
          if (e instanceof NormalizeError) return;
          throw e;
        }
        expect(JSON.stringify(deepCanon(once))).toBe(JSON.stringify(once));
      }),
    );
  });

  it("produces bytes stable across the §8.3 serialize → re-parse → serialize round trip", () => {
    fc.assert(
      fc.property(jsonDocument, (value) => {
        let bytes: string;
        try {
          bytes = canonicalString(deepCanon(value));
        } catch (e) {
          if (e instanceof NormalizeError) return;
          throw e;
        }
        expect(canonicalString(deepCanon(JSON.parse(bytes)))).toBe(bytes);
      }),
    );
  });
});

describe("parseLossless (EQUIVALENCE.md step 1 — exact-decimal parsing)", () => {
  // Replace every LosslessNumber with the float64 JSON.parse would have produced. Keys are
  // defined with Object.defineProperty (like parse.ts itself) so the rebuild never itself
  // mangles an unusual key — belt-and-suspenders alongside jsonDocument's ordinary keys.
  const toFloat64Tree = (v: unknown): unknown => {
    if (v instanceof LosslessNumber) return Number(v.value);
    if (Array.isArray(v)) return v.map(toFloat64Tree);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        Object.defineProperty(out, k, {
          value: toFloat64Tree(val),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return out;
    }
    return v;
  };

  it("agrees with JSON.parse for every float64-safe JSON document", () => {
    fc.assert(
      fc.property(jsonDocument, (value) => {
        const text = JSON.stringify(value);
        // Re-stringify both sides with identical (text-order) key insertion, sidestepping
        // deep-equality quirks around own "__proto__" keys the generator can mint.
        expect(JSON.stringify(toFloat64Tree(parseLossless(text)))).toBe(JSON.stringify(JSON.parse(text)));
      }),
    );
  });
});
