// Lossless JSON parsing for EQUIVALENCE.md step 1 (exact-decimal interpretation).
//
// `JSON.parse` coerces every number literal to an IEEE-754 float64, which silently
// loses precision for high-precision decimals and integers above 2^53. EQUIVALENCE.md step 1
// requires numbers to be interpreted from their *decimal text*, never via binary
// floating point. This parser preserves each number token verbatim as a
// `LosslessNumber`, so the canonicalizer (`canonNumber`) can reduce the exact source
// decimal to its lowest-terms fixed-point form.
//
// Only numbers are special-cased; objects, arrays, strings, booleans and null are
// produced as ordinary JS values. Feed the result to `normalizeDocument` /
// `equivalent`; schema validation (`validate`) runs on a plain `JSON.parse`, where
// float64 is harmless because it only checks types and ranges.

/** A JSON number preserved as its exact decimal source text. */
export class LosslessNumber {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
  toJSON(): string {
    // Defensive: keeps the exact text if a tree is accidentally JSON.stringify'd.
    return this.value;
  }
}

/** Parse JSON text, representing every number literal as a {@link LosslessNumber}. */
export function parseLossless(text: string): unknown {
  let i = 0;
  const n = text.length;

  const fail = (msg: string): never => {
    throw new SyntaxError(`parseLossless: ${msg} at offset ${i}`);
  };

  const skipWs = () => {
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  };

  const parseString = (): string => {
    i++; // opening quote
    let s = "";
    while (i < n) {
      const c = text[i++];
      if (c === '"') return s;
      if (c === "\\") {
        const e = text[i++];
        switch (e) {
          case '"':
            s += '"';
            break;
          case "\\":
            s += "\\";
            break;
          case "/":
            s += "/";
            break;
          case "b":
            s += "\b";
            break;
          case "f":
            s += "\f";
            break;
          case "n":
            s += "\n";
            break;
          case "r":
            s += "\r";
            break;
          case "t":
            s += "\t";
            break;
          case "u": {
            const hex = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid \\u escape");
            s += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            fail(`invalid escape \\${e}`);
        }
      } else if (c !== undefined && c.charCodeAt(0) <= 0x1f) {
        // RFC 8259 §7: control characters (U+0000–U+001F) MUST be escaped in strings.
        fail(`unescaped control character U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} in string`);
      } else {
        s += c;
      }
    }
    return fail("unterminated string");
  };

  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

  // RFC 8259 §6 number grammar: an optional minus, an int part with no leading zero,
  // an optional non-empty fraction, an optional non-empty exponent. The lexer below is
  // permissive (it just consumes number-ish characters); this anchors what it took.
  const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

  const parseNumber = (): LosslessNumber => {
    const start = i;
    if (text[i] === "-") i++;
    while (isDigit(text[i])) i++;
    if (text[i] === ".") {
      i++;
      while (isDigit(text[i])) i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      while (isDigit(text[i])) i++;
    }
    const token = text.slice(start, i);
    // Reject what JSON.parse rejects: "-", "1.", "01", "1e", "1e+", … — accepting them
    // would put non-JSON number spellings on the lossless path.
    if (!NUMBER.test(token)) fail(`invalid number ${JSON.stringify(token)}`);
    return new LosslessNumber(token);
  };

  const parseValue = (): unknown => {
    skipWs();
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "-" || isDigit(c)) return parseNumber();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    return fail(`unexpected token ${JSON.stringify(c)}`);
  };

  function parseObject(): Record<string, unknown> {
    i++; // {
    const obj: Record<string, unknown> = {};
    skipWs();
    if (text[i] === "}") {
      i++;
      return obj;
    }
    for (;;) {
      skipWs();
      if (text[i] !== '"') fail("expected string key");
      const key = parseString();
      skipWs();
      if (text[i] !== ":") fail("expected ':'");
      i++;
      obj[key] = parseValue();
      skipWs();
      const c = text[i];
      if (c === ",") {
        i++;
        continue;
      }
      if (c === "}") {
        i++;
        break;
      }
      fail("expected ',' or '}'");
    }
    return obj;
  }

  function parseArray(): unknown[] {
    i++; // [
    const arr: unknown[] = [];
    skipWs();
    if (text[i] === "]") {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      const c = text[i];
      if (c === ",") {
        i++;
        continue;
      }
      if (c === "]") {
        i++;
        break;
      }
      fail("expected ',' or ']'");
    }
    return arr;
  }

  const result = parseValue();
  skipWs();
  if (i < n) fail("unexpected trailing content");
  return result;
}
