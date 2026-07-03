export type { FixedPoint, Json } from "./canonical.js";
// Note: `standardDir` (a sibling-repo checkout path, OPENBODY_STANDARD-aware) is
// Node-only dev/test tooling and lives in `./schema-loader-node.js` instead — it is
// deliberately NOT re-exported here so importing this package's main entry point
// stays safe in a browser bundle (no node:fs/node:path/node:url in the module graph).
export { canonicalString, canonNumber, canonTimestamp, deepCanon } from "./canonical.js";
// The typed error hierarchy + the per-layer error policy (WP7) — see src/errors.ts's
// header for the full contract (validate reports, parse/normalize/mappers throw typed).
export { MapperInputError, NormalizeError, OpenBodyError, ParseError } from "./errors.js";
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
export type { NormalizeInput } from "./normalize.js";
export { equivalent, normalizeDocument } from "./normalize.js";
export { LosslessNumber, parseLossless } from "./parse.js";
export type { ResolvedExerciseRef, ResolveOptions } from "./resolve.js";
// §6.5 producer-side matching ladder: raw app exercise names → canonical registry ids
// (browser-safe: backed by the vendored registry snapshot, see src/resolve.ts).
export { resolveExerciseRef, sourceNameForId } from "./resolve.js";
// The wire format as types (WP6): one interface per schema $def, `OpenBodyRecord` the
// recordType-discriminated union, `WireRecord` the permissive escape hatch.
export type {
  AbsoluteTarget,
  Block,
  BlockPerformance,
  BlockScoring,
  CoreLinkType,
  Descriptors,
  EffortLoad,
  Envelope,
  Exercise,
  ExerciseRef,
  ExerciseRefObject,
  Extension,
  FixedPointObject,
  Intensity,
  Link,
  LiveRecord,
  Load,
  MapOptions,
  MapperResult,
  MapWarning,
  Measurement,
  MediaItem,
  Modifier,
  ModularFields,
  OpenBodyRecord,
  Outcome,
  Participant,
  Performance,
  PhasePatternPhase,
  Prescription,
  Program,
  ProgramPhase,
  Progression,
  Provenance,
  RampTarget,
  RangeTarget,
  RelativeToThresholdTarget,
  Rep,
  SampleArray,
  SampleDataPoint,
  ScalarOrTarget,
  ScalarOrTargetWithRamp,
  Session,
  Sides,
  StatusPeriod,
  StopConditionTarget,
  Target,
  TargetWithRamp,
  ThresholdProfile,
  ThresholdProfileEntry,
  Timestamp,
  Tombstone,
  WireNumber,
  WireRecord,
  WorkUnit,
} from "./types.js";
export { DEFAULT_SUBJECT } from "./types.js";
/**
 * `createValidator(schemaDoc)` compiles an arbitrary OpenBody JSON Schema document into a
 * `validate` function (ajv + the semantic checks the schema can't express) — useful for
 * validating against a custom/unmerged spec draft instead of the vendored snapshot that
 * backs the default `validate` export.
 */
export { createValidator, validate } from "./validate.js";
