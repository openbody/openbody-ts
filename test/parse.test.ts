// parseLossless: §8.3 step-1 lossless number interpretation (B1 / OB-9) — proves the
// parser preserves exact decimal text where JSON.parse (float64) loses it — plus the
// JSON grammar acceptance/rejection surface.
import { describe, expect, it } from "vitest";
import { ParseError } from "../src/errors.js";
import { LosslessNumber, parseLossless } from "../src/parse.js";
import type { WireRecord } from "../src/types.js";

describe("parseLossless preserves exact source text", () => {
  it("keeps >2^53 integer text", () => {
    const v = parseLossless("9007199254740993") as LosslessNumber; // 2^53 + 1
    expect(v).toBeInstanceOf(LosslessNumber);
    expect(v.value).toBe("9007199254740993");
    // JSON.parse cannot: it rounds to 2^53.
    expect(JSON.parse("9007199254740993")).toBe(9007199254740992);
  });

  it("keeps high-precision decimal text", () => {
    const v = parseLossless("1.00000000000000001") as LosslessNumber;
    expect(v.value).toBe("1.00000000000000001");
    expect(JSON.parse("1.00000000000000001")).toBe(1); // float64 collapses to 1
  });
});

describe("parseLossless accepts valid JSON", () => {
  it("parses objects/arrays/strings/booleans/null as plain JS values", () => {
    const doc = parseLossless('{"a": [true, false, null, "s\\u00e9\\n"], "b": {}}') as WireRecord;
    expect(doc.a).toEqual([true, false, null, "sé\n"]);
    expect(doc.b).toEqual({});
  });

  it("parses every number form as LosslessNumber", () => {
    for (const t of ["0", "-0", "1", "-12", "0.5", "1.25", "1e3", "1E+3", "2.5e-2", "-0.001"]) {
      const v = parseLossless(t) as LosslessNumber;
      expect(v, t).toBeInstanceOf(LosslessNumber);
      expect(v.value).toBe(t);
    }
  });

  it("handles escapes and whitespace", () => {
    expect(parseLossless(' "a\\"b\\\\c\\/d\\b\\f\\r\\t" ')).toBe('a"b\\c/d\b\f\r\t');
    expect(parseLossless(" [ 1 ,\n2 ]\t") as unknown[]).toHaveLength(2);
  });
});

// C5: the lexer used to ACCEPT non-JSON number spellings ("-", "1.", "01", "1e") and
// unescaped control characters in strings; both are now rejected (RFC 8259 §6/§7).
describe("parseLossless rejects invalid number tokens (RFC 8259 §6)", () => {
  const badNumbers = ["-", "1.", "01", "1e", "-01", "00", "1e+", "1.e3", "-.5", "1E-", "0.e1"];
  it.each(badNumbers)("rejects %j", (t) => {
    expect(() => parseLossless(t)).toThrow(/invalid number/);
    expect(() => JSON.parse(t)).toThrow(); // parity: JSON.parse rejects these too
  });
  it("rejects them nested inside documents", () => {
    expect(() => parseLossless('{"a": 01}')).toThrow(/invalid number/);
    expect(() => parseLossless("[1., 2]")).toThrow(/invalid number/);
    expect(() => parseLossless('{"a": [3, 1e]}')).toThrow(/invalid number/);
  });
  it("still accepts every valid number spelling", () => {
    for (const t of ["0", "-0", "10", "0.5", "0.0", "1e0", "1E+3", "1e-3", "123.456e-7", "-9007199254740993"]) {
      const v = parseLossless(t) as LosslessNumber;
      expect(v.value, t).toBe(t);
    }
  });
});

describe("parseLossless rejects unescaped control characters in strings (RFC 8259 \u00a77)", () => {
  it.each([
    ["\u0000", "NUL"],
    ["\n", "newline"],
    ["\r", "carriage return"],
    ["\t", "tab"],
    ["\u001f", "unit separator"],
  ])("rejects a raw control char (%s)", (ch) => {
    expect(() => parseLossless(`"a${ch}b"`)).toThrow(/unescaped control character/);
    expect(() => JSON.parse(`"a${ch}b"`)).toThrow(); // parity with JSON.parse
  });
  it("accepts the same characters when escaped", () => {
    expect(parseLossless('"a\\nb\\tc\\u0000d"')).toBe("a\nb\tc\u0000d");
  });
  it("accepts U+0020 and above unescaped", () => {
    expect(parseLossless('" ~\u00e9\ud83d\ude00"')).toBe(" ~\u00e9\ud83d\ude00");
  });
});

// Regression: a "__proto__" key must become an OWN enumerable property (like JSON.parse),
// never hit Object.prototype's setter — that would drop the payload AND pollute the
// prototype. defineProperty in parse.ts guards it; this pins the JSON.parse-parity contract.
describe("parseLossless handles __proto__ as an own key (no prototype pollution)", () => {
  it("makes __proto__ an own enumerable property and leaves the prototype clean", () => {
    const r = parseLossless('{"a":1,"__proto__":{"x":2}}') as WireRecord;
    expect(Object.keys(r)).toContain("__proto__"); // enumerable own key
    expect(Object.hasOwn(r, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(r), "prototype must be untouched — no pollution").toBe(Object.prototype);
    // Parity: JSON.parse also creates an own "__proto__" data property.
    expect(Object.keys(JSON.parse('{"a":1,"__proto__":{"x":2}}'))).toEqual(Object.keys(r));
  });
  it("preserves a scalar __proto__ value rather than dropping it", () => {
    const r = parseLossless('{"__proto__":5}') as WireRecord;
    expect(Object.keys(r)).toEqual(["__proto__"]);
    // Read the OWN data property (not the inherited accessor) to prove the payload survived.
    const own = Object.getOwnPropertyDescriptor(r, "__proto__")?.value as LosslessNumber;
    expect(own.value).toBe("5"); // preserved verbatim as a LosslessNumber
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
  });
});

describe("parseLossless rejects malformed JSON", () => {
  const bad = [
    ["", "empty input"],
    ["{", "unterminated object"],
    ['{"a" 1}', "missing colon"],
    ['{"a": 1,}', "trailing comma in object"],
    ["[1, 2", "unterminated array"],
    ['"abc', "unterminated string"],
    ['"\\x"', "invalid escape"],
    ['"\\u12g4"', "invalid unicode escape"],
    ["1 2", "trailing content"],
    ["tru", "bad literal"],
  ] as const;
  it.each(bad)("rejects %j (%s)", (text) => {
    expect(() => parseLossless(text)).toThrow(ParseError);
  });
});
