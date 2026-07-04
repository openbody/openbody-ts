// OpenBody mapper SDK: convert incumbent export formats into OpenBody wire records.
// Each mapper is a pure function (input → MapperResult { records, warnings });
// structurally unusable input throws MapperInputError, degraded/skipped/defaulted
// data is reported on the warnings channel (the WP7 policy — see src/errors.ts).
// Validate/normalize with the core (`validate`, `normalizeDocument`). Health Connect
// is covered by the Apple Health mapper (documented identical mapping).

export { mapAppleHealth } from "./apple-health.js";
export { mapConcept2 } from "./concept2.js";
export { type FitInput, mapFit } from "./fit.js";
export { type FitbitFile, type FitbitMapOptions, mapFitbitTakeout } from "./fitbit.js";
export { mapGpx } from "./gpx.js";
export { mapHevy } from "./hevy.js";
export { mapHevyMeasurements } from "./hevy-measurements.js";
export { mapStrava, type StravaInput } from "./strava.js";
export { mapStrong } from "./strong.js";
export { mapTcx } from "./tcx.js";
export { mapTheCrag } from "./thecrag.js";
// Outbound (OpenBody → incumbent): the mirror direction, currently just Strong. Returns
// { csv, omissions } — SPEC §10's directional-lossless rule: emitting into a less-expressive
// target is best-effort, and every material loss is reported (or throws with { strict: true }).
export { mapOpenBodyToStrong, type StrongOmission, type ToStrongOptions, type ToStrongResult } from "./to-strong.js";
// Internal plumbing (parseCsv/num/toRfc3339/contentHash) stays in ./csv.js — import it
// directly within this repo; it is deliberately not part of the public barrel.
