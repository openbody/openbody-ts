// Copies the current schema/openbody.schema.json from the sibling standard repo
// (default ../openbody, override with OPENBODY_STANDARD) into vendor/ so the
// published package ships a schema snapshot instead of depending on a sibling
// checkout at runtime (see src/validate.ts). Run automatically pre-pack/publish
// (package.json "prepack"); safe to re-run any time during development.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standardDir = process.env.OPENBODY_STANDARD
  ? path.resolve(process.env.OPENBODY_STANDARD)
  : path.resolve(root, "../openbody");

const src = path.join(standardDir, "schema/openbody.schema.json");
const destDir = path.join(root, "vendor");
const dest = path.join(destDir, "openbody.schema.json");

if (!fs.existsSync(src)) {
  console.error(`sync-schema: no schema found at ${src} — set OPENBODY_STANDARD or check out the sibling openbody repo.`);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`sync-schema: ${src} -> ${dest}`);
