// Internal mapper plumbing (src/mappers/csv.ts): quoted-CSV edge cases, the
// toRfc3339 wall-clock format matrix, num()'s non-finite rejection, and the
// content-hash id primitive.
import { describe, expect, it } from "vitest";
import { contentHash, num, parseCsv, toRfc3339 } from "../src/mappers/csv.js";

describe("parseCsv", () => {
  it("parses plain rows into header-keyed records", () => {
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });
  it("handles quoted commas", () => {
    expect(parseCsv('name,notes\nSquat,"heavy, slow"')).toEqual([{ name: "Squat", notes: "heavy, slow" }]);
  });
  it("handles embedded newlines inside quoted cells", () => {
    expect(parseCsv('name,notes\nSquat,"line one\nline two"')).toEqual([
      { name: "Squat", notes: "line one\nline two" },
    ]);
  });
  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4\r\n")).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });
  it("handles escaped quotes (doubled)", () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([{ a: 'say "hi"' }]);
  });
  it("supports an alternate delimiter", () => {
    expect(parseCsv("a;b\n1;2", ";")).toEqual([{ a: "1", b: "2" }]);
  });
  it("fills short rows with empty strings", () => {
    expect(parseCsv("a,b,c\n1,2")).toEqual([{ a: "1", b: "2", c: "" }]);
  });
  it("returns [] for empty/header-only input", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("a,b\n")).toEqual([]);
  });
});

describe("toRfc3339 (offset-less wall-clock formats, never host-TZ-dependent)", () => {
  it("ISO-ish date-times (Strong/Concept2)", () => {
    expect(toRfc3339("2026-03-02 06:45:00")).toBe("2026-03-02T06:45:00Z");
    expect(toRfc3339("2026-03-02T06:45:00")).toBe("2026-03-02T06:45:00Z");
    expect(toRfc3339("2026-03-02 06:45")).toBe("2026-03-02T06:45:00Z");
  });
  it("bare dates", () => {
    expect(toRfc3339("2026-03-02")).toBe("2026-03-02T00:00:00Z");
  });
  it("Hevy's day-month-year form", () => {
    expect(toRfc3339("22 Dec 2025, 08:00")).toBe("2025-12-22T08:00:00Z");
    expect(toRfc3339("22 Dec 2025, 08:00:15")).toBe("2025-12-22T08:00:15Z");
    expect(toRfc3339("2 December 2025 8:05")).toBe("2025-12-02T08:05:00Z");
  });
  it("stamps the caller's utcOffset instead of Z", () => {
    expect(toRfc3339("2026-03-02 06:45:00", "-07:00")).toBe("2026-03-02T06:45:00-07:00");
    expect(toRfc3339("22 Dec 2025, 08:00", "+01:00")).toBe("2025-12-22T08:00:00+01:00");
  });
  it("passes through strings that already carry an offset, and anything unrecognized", () => {
    expect(toRfc3339("2026-05-16T00:00:00Z")).toBe("2026-05-16T00:00:00Z");
    expect(toRfc3339("2026-05-16T00:00:00+10:00")).toBe("2026-05-16T00:00:00+10:00");
    expect(toRfc3339("not a date")).toBe("not a date");
    expect(toRfc3339("32 Foo 2025, 08:00")).toBe("32 Foo 2025, 08:00"); // unknown month → untouched
    expect(toRfc3339("  2026-03-02 06:45:00  ")).toBe("2026-03-02T06:45:00Z"); // trimmed
  });
});

describe("num", () => {
  it("parses finite numbers", () => {
    expect(num("12.5")).toBe(12.5);
    expect(num("0")).toBe(0);
    expect(num("-3")).toBe(-3);
  });
  it("returns undefined for blank/missing cells", () => {
    expect(num(undefined)).toBeUndefined();
    expect(num("")).toBeUndefined();
  });
  it("rejects non-finite values (a malformed cell must not put NaN on the wire)", () => {
    expect(num("abc")).toBeUndefined();
    expect(num("Infinity")).toBeUndefined();
    expect(num("-Infinity")).toBeUndefined();
    expect(num("NaN")).toBeUndefined();
  });
});

describe("contentHash", () => {
  it("is a stable 8-hex-digit FNV-1a digest", () => {
    expect(contentHash("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    expect(contentHash("")).toMatch(/^[0-9a-f]{8}$/);
  });
});
