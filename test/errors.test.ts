// WP7: the typed error hierarchy + per-layer policy (src/errors.ts). One
// representative throw site per class, instanceof chains, and the `code` fields.
import { describe, expect, it } from "vitest";
import { canonNumber } from "../src/canonical.js";
import { MapperInputError, NormalizeError, OpenBodyError, ParseError } from "../src/errors.js";
import { mapStrong } from "../src/mappers/index.js";
import { normalizeDocument } from "../src/normalize.js";
import { parseLossless } from "../src/parse.js";
import { validate } from "./helpers.js";

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw");
};

describe("error hierarchy (WP7)", () => {
  it("ParseError from parseLossless: instanceof chain, code, offset", () => {
    const e = caught(() => parseLossless("[1, 2"));
    expect(e).toBeInstanceOf(ParseError);
    expect(e).toBeInstanceOf(OpenBodyError);
    expect(e).toBeInstanceOf(Error);
    const pe = e as ParseError;
    expect(pe.code).toBe("parse");
    expect(pe.name).toBe("ParseError");
    expect(pe.offset).toBe(5);
    expect(pe.message).toMatch(/at offset 5/);
  });

  it("NormalizeError from normalizeDocument: invalid roundScheme combination (§5.4)", () => {
    const doc = {
      id: "b1",
      recordType: "Block",
      roundScheme: [21, 15, 9],
      repetitions: 3,
      children: [],
    };
    const e = caught(() => normalizeDocument(doc));
    expect(e).toBeInstanceOf(NormalizeError);
    expect(e).toBeInstanceOf(OpenBodyError);
    expect((e as NormalizeError).code).toBe("normalize");
    expect((e as NormalizeError).message).toMatch(/roundScheme\+repetitions/);
  });

  it("NormalizeError from normalizeDocument: sets+performance is invalid (§5.5)", () => {
    const doc = {
      id: "w1",
      recordType: "WorkUnit",
      scoring: "reps",
      prescription: { sets: 3, reps: 5 },
      performance: { reps: 5 },
    };
    // sets expansion happens on container children — wrap in a Session.
    const session = { id: "s1", recordType: "Session", subject: "x", workUnits: [doc] };
    expect(() => normalizeDocument(session)).toThrow(NormalizeError);
  });

  it("NormalizeError from canonNumber: non-numeric fixed-point coefficient names the value", () => {
    const e = caught(() => canonNumber({ coefficient: "abc", exponent: 0 }));
    expect(e).toBeInstanceOf(NormalizeError);
    expect((e as NormalizeError).message).toContain('"abc"');
    expect(() => canonNumber({ coefficient: 1, exponent: "x" })).toThrow(NormalizeError);
  });

  it("MapperInputError from a mapper: mapper + detail + code fields", () => {
    const e = caught(() => mapStrong("a,b\n1,2"));
    expect(e).toBeInstanceOf(MapperInputError);
    expect(e).toBeInstanceOf(OpenBodyError);
    const me = e as MapperInputError;
    expect(me.code).toBe("mapper-input");
    expect(me.mapper).toBe("strong");
    expect(me.name).toBe("MapperInputError");
    expect(me.detail).toBe("missing-columns:Date,Workout Name,Exercise Name");
  });

  it("policy: validate reports invalid documents via its result object, never throws", () => {
    // §5.12: a scalar load value without a unit is invalid — reported, not thrown.
    const v = validate({
      id: "w1",
      recordType: "WorkUnit",
      subject: "x",
      scoring: "reps",
      performance: { reps: 5, load: { value: 100 } },
    });
    expect(v.valid).toBe(false);
    expect(v.errors).toBeTruthy();
  });
});
