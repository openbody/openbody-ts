// The package's typed error hierarchy (WP7) — every deliberate throw in this package
// is an OpenBodyError subclass, so callers can catch by layer (`instanceof`) or switch
// on the machine-readable `code` without parsing messages.
//
// Per-layer error policy (the contract every module here follows):
//   - `validate` / `createValidator` REPORT invalid documents via their result object
//     (`{ valid, errors }`) — they never throw on invalid input.
//   - `parseLossless` throws {@link ParseError} on malformed JSON text.
//   - `normalizeDocument` / `equivalent` (and the canonicalization primitives under
//     them) throw {@link NormalizeError} on structurally malformed records — invalid
//     roundScheme/sets combinations, non-numeric fixed-point parts.
//   - Inbound mappers throw {@link MapperInputError} when the input is structurally
//     unusable (wrong file shape, missing required column/stream) and NEVER throw on
//     merely-missing optional data — that degrades and is reported on the
//     `MapperResult.warnings` channel instead (see `MapWarning` in types.ts).
//   - The outbound Strong mapper keeps its own established contract: best-effort
//     `{ csv, omissions }`, throwing only under `{ strict: true }`.

/**
 * Base class for every error this package throws deliberately. `code` is a stable,
 * machine-readable token (kebab-case) identifying the failure kind.
 */
export class OpenBodyError extends Error {
  /** Stable machine-readable failure token (e.g. "mapper-input", "parse", "normalize"). */
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
    // Keeps `instanceof` truthful even if a consumer's toolchain downlevels class emit
    // below ES2015 semantics (harmless no-op under this package's own ES2022 emit).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * An inbound mapper received structurally unusable input: not the documented file
 * shape, or missing a column/stream/element the mapping cannot proceed without.
 * Merely-missing optional data never raises this — it degrades with a `MapWarning`.
 */
export class MapperInputError extends OpenBodyError {
  /** Which mapper rejected the input (e.g. "strava", "strong"). */
  readonly mapper: string;
  /** Optional extra machine-usable context (e.g. the missing column names). */
  readonly detail?: string;

  constructor(mapper: string, message: string, detail?: string) {
    super("mapper-input", `${mapper}: ${message}`);
    this.mapper = mapper;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * `normalizeDocument`/`equivalent` (or the canonicalization primitives under them)
 * met a structurally malformed record: an invalid roundScheme/sets combination
 * (§5.4/§5.5), or a fixed-point object whose coefficient/exponent is not numeric.
 */
export class NormalizeError extends OpenBodyError {
  constructor(message: string, options?: ErrorOptions) {
    super("normalize", message, options);
  }
}

/** `parseLossless` met malformed JSON text. `offset` is the character position of the failure. */
export class ParseError extends OpenBodyError {
  /** 0-based character offset into the input text where parsing failed. */
  readonly offset?: number;

  constructor(message: string, offset?: number) {
    super("parse", message);
    if (offset !== undefined) this.offset = offset;
  }
}
