export { normalizeDocument, equivalent } from "./normalize.js";
export { validate } from "./validate.js";
// Note: `standardDir` (a sibling-repo checkout path, OPENBODY_STANDARD-aware) is
// Node-only dev/test tooling and lives in `./schema-loader-node.js` instead — it is
// deliberately NOT re-exported here so importing this package's main entry point
// stays safe in a browser bundle (no node:fs/node:path/node:url in the module graph).
export { canonicalString, canonNumber, canonTimestamp, deepCanon } from "./canonical.js";
export { parseLossless, LosslessNumber } from "./parse.js";
export { mapHevy, mapStrong, mapStrava, mapAppleHealth } from "./mappers/index.js";
export type { Json, FixedPoint } from "./canonical.js";
