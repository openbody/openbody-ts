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

// §5.2 Program.phases cross-checks the schema cannot express (they compare two
// arrays on the same record, not a fixed shape): every phases[].sessions entry
// MUST also appear in top-level sessions when sessions is present (and a phase
// MUST NOT reference a session id absent from it — the same rule stated twice
// in SPEC.md), and a session id MUST NOT appear in more than one phase's
// sessions array (phases are disjoint). Both are intra-record, so no
// whole-document context is needed. Phase-internal order-consistency with
// top-level `sessions` (contiguous, order-preserving subsequence) is NOT
// checked here — see the schema's top-of-file disclaimer for that gap.
function validateProgramPhases(record: Record<string, any>): string[] {
  if (record?.recordType !== "Program" || !Array.isArray(record.phases)) return [];
  const topSessions: unknown[] | undefined = Array.isArray(record.sessions) ? record.sessions : undefined;
  const errors: string[] = [];
  const seen = new Set<unknown>();
  record.phases.forEach((phase: any, i: number) => {
    if (!phase || !Array.isArray(phase.sessions)) return;
    for (const id of phase.sessions) {
      if (topSessions && !topSessions.includes(id)) {
        errors.push(`phases[${i}].sessions references "${id}" which is absent from top-level sessions (§5.2)`);
      }
      if (seen.has(id)) {
        errors.push(`session id "${id}" appears in more than one phase's sessions — phases MUST be disjoint (§5.2)`);
      }
      seen.add(id);
    }
  });
  return errors;
}

export function validate(record: unknown): { valid: boolean; errors: string | null } {
  const ok = _validate(record);
  const phaseErrors = ok ? validateProgramPhases(record as Record<string, any>) : [];
  const valid = !!ok && phaseErrors.length === 0;
  if (valid) return { valid: true, errors: null };
  const parts: string[] = [];
  if (!ok) parts.push(ajv.errorsText(_validate.errors, { separator: "; " }));
  parts.push(...phaseErrors);
  return { valid: false, errors: parts.join("; ") };
}
