// Schema validation against the published OpenBody JSON Schema (§§4-7).
// During local development the schema is read from the sibling standard repo
// (default ../openbody, override with OPENBODY_STANDARD). When this SDK is
// published it will bundle/depend on a versioned schema artifact instead.
import fs from "node:fs";
import path from "node:path";
import Ajv2020Mod from "ajv/dist/2020.js";
import addFormatsMod from "ajv-formats";
// ajv / ajv-formats are CJS; casts fix NodeNext default-import types (runtime is fine).
const Ajv2020 = Ajv2020Mod as unknown as { new (opts?: Record<string, unknown>): any };
const addFormats = addFormatsMod as unknown as (ajv: any) => void;

export const standardDir = process.env.OPENBODY_STANDARD
  ? path.resolve(process.env.OPENBODY_STANDARD)
  : path.resolve(process.cwd(), "../openbody");

const schema = JSON.parse(fs.readFileSync(path.join(standardDir, "schema/openbody.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const _validate = ajv.compile(schema);

export function validate(record: unknown): { valid: boolean; errors: string | null } {
  const ok = _validate(record);
  return { valid: !!ok, errors: ok ? null : ajv.errorsText(_validate.errors, { separator: "; " }) };
}
