// Shared public types for the mapper SDK. These used to live in src/mappers/csv.ts
// (the CSV utility the first mappers happened to share), but they are the package's
// public mapper contract, not CSV plumbing — every mapper takes a MapOptions and
// returns OpenBodyRecord[], whatever its input format.

/** One OpenBody wire record (validate with `validate`, normalize with `normalizeDocument`). */
export type OpenBodyRecord = Record<string, any>;

/**
 * The placeholder subject id every mapper stamps when `MapOptions.subject` is absent
 * (Q5 groundwork: a later errors/warnings surface will warn when output falls back to
 * this — callers should pass their own subject id).
 */
export const DEFAULT_SUBJECT = "subj-001";

/** Options shared by every inbound mapper. */
export interface MapOptions {
  subject?: string;
  /** RFC 3339 offset (e.g. "-07:00") stamped onto the source's offset-less local wall-clock timestamps. Default "Z". */
  utcOffset?: string;
}
