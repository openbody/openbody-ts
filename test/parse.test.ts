// parseLossless: §8.3 step-1 lossless number interpretation (B1 / OB-9) — proves the
// parser preserves exact decimal text where JSON.parse (float64) loses it — plus the
// JSON grammar acceptance/rejection surface.
import { describe, expect, it } from "vitest";
import { parseLossless, LosslessNumber } from "../src/parse.js";

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
    const doc = parseLossless('{"a": [true, false, null, "s\\u00e9\\n"], "b": {}}') as any;
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
    expect(parseLossless(" [ 1 ,\n2 ]\t") as any).toHaveLength(2);
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
    expect(() => parseLossless(text)).toThrow(SyntaxError);
  });
});
