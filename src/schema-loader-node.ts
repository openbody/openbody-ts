// Node-only dev/test schema resolution — NOT re-exported from `src/index.ts` (the
// package's public entry point). Importing this module pulls in `node:fs`/
// `node:path`/`node:url`, which is fine for Node-only dev tooling (the conformance-
// vector runner, `pin-expected.ts`, the mapper round-trip tests) but must never leak
// into the browser-facing module graph — see `src/validate.ts`'s header for why that
// module stays pure and imports the vendored schema statically instead.
//
// `standardDir` (a full sibling-repo checkout, default ../openbody, override with
// OPENBODY_STANDARD) is what the conformance-vector runner and test scripts need for
// their own file paths (vectors/corpus directories). The schema itself is resolved
// with the same precedence documented before this split existed: OPENBODY_STANDARD
// wins if set (so iterating on an unmerged spec change works without re-syncing);
// otherwise this prefers the vendored copy this package ships
// (`vendor/openbody.schema.json`, refreshed from the sibling repo by
// `npm run sync-schema`, run automatically pre-pack/publish), falling back to the
// sibling-repo path only if the vendored copy hasn't been synced yet (e.g. a fresh
// clone before the first build). Both paths are resolved relative to this module's
// own location, not `process.cwd()` — a consumer importing this package from an
// arbitrary working directory must still find the schema.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "./validate.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const standardDir = process.env.OPENBODY_STANDARD
  ? path.resolve(process.env.OPENBODY_STANDARD)
  : path.resolve(packageRoot, "../openbody");

const vendoredSchemaPath = path.join(packageRoot, "vendor/openbody.schema.json");
const schemaPath = process.env.OPENBODY_STANDARD
  ? path.join(standardDir, "schema/openbody.schema.json")
  : fs.existsSync(vendoredSchemaPath)
    ? vendoredSchemaPath
    : path.join(standardDir, "schema/openbody.schema.json");

const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

// `validate` bound to the OPENBODY_STANDARD-resolved schema (falls back to the
// vendored/sibling-repo schema per the precedence above) — for dev/test scripts only.
export const validate = createValidator(schema);
