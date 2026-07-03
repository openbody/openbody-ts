export type { FixedPoint, Json } from "./canonical.js";
// Note: `standardDir` (a sibling-repo checkout path, OPENBODY_STANDARD-aware) is
// Node-only dev/test tooling and lives in `./schema-loader-node.js` instead — it is
// deliberately NOT re-exported here so importing this package's main entry point
// stays safe in a browser bundle (no node:fs/node:path/node:url in the module graph).
export { canonicalString, canonNumber, canonTimestamp, deepCanon } from "./canonical.js";
export type {
  FitbitFile,
  FitbitMapOptions,
  FitInput,
  StravaInput,
  StrongOmission,
  ToStrongOptions,
  ToStrongResult,
} from "./mappers/index.js";
// The full mapper SDK (all browser-safe — no node:* imports in this module graph):
// inbound (incumbent format → OpenBody wire records) + outbound (OpenBody → Strong CSV).
export {
  mapAppleHealth,
  mapConcept2,
  mapFit,
  mapFitbitTakeout,
  mapGpx,
  mapHevy,
  mapOpenBodyToStrong,
  mapStrava,
  mapStrong,
  mapTcx,
  mapTheCrag,
} from "./mappers/index.js";
export { equivalent, normalizeDocument } from "./normalize.js";
export { LosslessNumber, parseLossless } from "./parse.js";
export type { ResolvedExerciseRef, ResolveOptions } from "./resolve.js";
// §6.5 producer-side matching ladder: raw app exercise names → canonical registry ids
// (browser-safe: backed by the vendored registry snapshot, see src/resolve.ts).
export { resolveExerciseRef, sourceNameForId } from "./resolve.js";
export type { MapOptions, OpenBodyRecord } from "./types.js";
/**
 * `createValidator(schemaDoc)` compiles an arbitrary OpenBody JSON Schema document into a
 * `validate` function (ajv + the semantic checks the schema can't express) — useful for
 * validating against a custom/unmerged spec draft instead of the vendored snapshot that
 * backs the default `validate` export.
 */
export { createValidator, validate } from "./validate.js";
