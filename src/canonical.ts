// Canonicalization primitives for the OpenBody normalized-equivalence method (conformance/EQUIVALENCE.md; SPEC §8.3 points there).
import canonicalizeMod from "canonicalize";
import { LosslessNumber } from "./parse.js";
// canonicalize is CJS (module.exports = fn); cast fixes NodeNext default-import types.
const canonicalize = canonicalizeMod as unknown as (v: unknown) => string | undefined;

export type Json = null | boolean | string | number | Json[] | { [k: string]: Json };
export interface FixedPoint { coefficient: string; exponent: string }

const TIMESTAMP_FIELDS = new Set(["startTime", "endTime", "asOf", "from", "to"]);

/**
 * Step 1 (numbers): reduce any numeric value to lowest-terms fixed-point with string
 * coefficient/exponent (EQUIVALENCE.md). Accepts a {@link LosslessNumber} (exact source decimal,
 * the spec-correct input), a fixed-point `{coefficient, exponent}` object, or — as a
 * lossy fallback for callers that pre-parsed with `JSON.parse` — a JS number.
 *
 * For full EQUIVALENCE.md fidelity, parse documents with {@link parseLossless} so numbers arrive
 * as `LosslessNumber`; the plain-number path can lose precision above 2^53 or for
 * high-precision decimals.
 */
export function canonNumber(
  n: number | LosslessNumber | { coefficient: unknown; exponent: unknown },
): FixedPoint {
  let coeff: bigint;
  let exp: number;
  if (n instanceof LosslessNumber) {
    [coeff, exp] = decimalParts(n.value);
  } else if (typeof n === "number") {
    [coeff, exp] = decimalParts(n.toString());
  } else {
    coeff = BigInt(String((n as any).coefficient).trim());
    exp = Number(String((n as any).exponent).trim());
  }
  if (coeff === 0n) return { coefficient: "0", exponent: "0" };
  const negative = coeff < 0n;
  if (negative) coeff = -coeff;
  while (coeff % 10n === 0n) { coeff /= 10n; exp += 1; }
  return { coefficient: (negative ? "-" : "") + coeff.toString(), exponent: String(exp) };
}

function decimalParts(s: string): [bigint, number] {
  s = s.trim();
  let exp = 0;
  const e = s.search(/[eE]/);
  if (e >= 0) { exp = parseInt(s.slice(e + 1), 10); s = s.slice(0, e); }
  const dot = s.indexOf(".");
  if (dot >= 0) { exp -= s.length - dot - 1; s = s.slice(0, dot) + s.slice(dot + 1); }
  return [BigInt(s), exp];
}

export function isFixedPointLike(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v)
    && "coefficient" in (v as any) && "exponent" in (v as any)
    && Object.keys(v as any).length === 2;
}

/** Step 1 (timestamps): canonical RFC 3339 spelling (EQUIVALENCE.md step 1). */
export function canonTimestamp(s: string): string {
  let t = s.trim().toUpperCase();
  // zero offset -> Z
  t = t.replace(/[+-]00:00$/, "Z");
  // strip trailing-zero fractional seconds (and a bare dot)
  t = t.replace(/(\.\d*?)0+(?=Z|[+-]\d\d:\d\d|$)/, "$1").replace(/\.(?=Z|[+-]\d\d:\d\d|$)/, "");
  return t;
}

// Subtrees whose contents are opaque (§8): a fixed-point-shaped object inside them is a
// plain object, NOT re-read as a number; field names there carry no spec meaning.
const OPAQUE_KEYS = new Set(["extension", "script"]);

/**
 * Recursively apply number + timestamp canonicalization across a record (EQUIVALENCE.md step 1).
 * Bare numbers are canonicalized everywhere (so JCS never float64-formats), but a
 * `{coefficient, exponent}` *object* is collapsed to fixed-point only OUTSIDE opaque
 * `extension`/`script` subtrees; inside them it stays a structural object, and timestamp
 * fields aren't re-spelled (the keys aren't the spec's timestamp fields).
 */
export function deepCanon(value: unknown, inOpaque = false): Json {
  if (value instanceof LosslessNumber) return canonNumber(value) as unknown as Json;
  if (typeof value === "number") return canonNumber(value) as unknown as Json;
  if (!inOpaque && isFixedPointLike(value)) return canonNumber(value as any) as unknown as Json;
  if (Array.isArray(value)) return value.map((v) => deepCanon(v, inOpaque));
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childOpaque = inOpaque || OPAQUE_KEYS.has(k);
      out[k] = (!inOpaque && typeof v === "string" && TIMESTAMP_FIELDS.has(k)) ? canonTimestamp(v) : deepCanon(v, childOpaque);
    }
    return out;
  }
  return value as Json;
}

/** Step 9: order the set-valued arrays per EQUIVALENCE.md step 9 (key order, then canonical-byte tiebreak). */
const SET_ARRAY_KEYS: Record<string, string[]> = {
  links: ["type", "ref"],
  effortLoad: ["kind", "method"],
  intensity: ["dimension"],
  modifiers: ["type"],
  media: ["url"],
};

// Set-valued arrays of plain scalar tokens (no element keys) — ordered by token value.
const SET_ARRAY_SCALARS = new Set(["qualities"]);

function orderSetArrays(value: Json): Json {
  if (Array.isArray(value)) return value.map(orderSetArrays);
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) {
      let nv = orderSetArrays(v as Json);
      if (Array.isArray(nv) && SET_ARRAY_SCALARS.has(k)) {
        nv = [...nv].sort((a, b) => {
          const as = String(a);
          const bs = String(b);
          return as < bs ? -1 : as > bs ? 1 : 0;
        });
      } else if (Array.isArray(nv) && k in SET_ARRAY_KEYS) {
        const keys = SET_ARRAY_KEYS[k];
        nv = [...nv].sort((a, b) => {
          for (const kk of keys) {
            const av = String((a as any)?.[kk] ?? "");
            const bv = String((b as any)?.[kk] ?? "");
            if (av !== bv) return av < bv ? -1 : 1;
          }
          const ab = canonicalize(a) ?? "";
          const bb = canonicalize(b) ?? "";
          return ab < bb ? -1 : ab > bb ? 1 : 0;
        });
      }
      out[k] = nv;
    }
    return out;
  }
  return value;
}

/** Produce the canonical byte string for one normalized record (RFC 8785 JCS). */
export function canonicalString(record: Json): string {
  const ordered = orderSetArrays(record);
  const s = canonicalize(ordered);
  if (s === undefined) throw new Error("canonicalize failed");
  return s;
}
