// OpenBody mapper SDK: convert incumbent export formats into OpenBody wire records.
// Each mapper is a pure function (input → records[]); validate/normalize with the
// core (`validate`, `normalizeDocument`). Health Connect is covered by the Apple
// Health mapper (documented identical mapping).
export { mapHevy } from "./hevy.js";
export { mapStrong } from "./strong.js";
export { mapStrava, type StravaInput } from "./strava.js";
export { mapAppleHealth } from "./apple-health.js";
export { mapFit, type FitInput } from "./fit.js";
export { mapGpx } from "./gpx.js";
export { mapTcx } from "./tcx.js";
// Outbound (OpenBody → incumbent): the mirror direction, currently just Strong. Returns
// { csv, omissions } — SPEC §10's directional-lossless rule: emitting into a less-expressive
// target is best-effort, and every material loss is reported (or throws with { strict: true }).
export { mapOpenBodyToStrong, type ToStrongOptions, type ToStrongResult, type StrongOmission } from "./to-strong.js";
export { parseCsv, num, toRfc3339, type OpenBodyRecord, type MapOptions } from "./csv.js";
