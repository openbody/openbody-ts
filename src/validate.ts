// Schema validation against the published OpenBody JSON Schema (§§4-7).
//
// This module is the package's public, browser-safe validation surface — it must
// stay free of `node:*` imports so bundling this package for a browser (Vite/Astro/
// etc.) doesn't pull in Node built-ins. The default `validate` export is compiled
// once, at module load, against the schema this package vendors and ships
// (`vendor/openbody.schema.json`, a static JSON import baked in at build time —
// refreshed from the sibling `openbody` repo by `npm run sync-schema`, run
// automatically pre-pack/publish).
//
// Dev/test workflows that need to validate against an unmerged local spec change
// (the `OPENBODY_STANDARD` env override) or need `standardDir` (a full sibling-repo
// checkout path) do NOT use this module directly — see `src/schema-loader-node.ts`,
// a Node-only sibling module (not re-exported from `src/index.ts`) that resolves
// OPENBODY_STANDARD > vendored > sibling-repo-fallback and builds its own `validate`
// via `createValidator` below.
import schema from "../vendor/openbody.schema.json" with { type: "json" };
import Ajv2020Mod from "ajv/dist/2020.js";
import addFormatsMod from "ajv-formats";
// ajv / ajv-formats are CJS; casts fix NodeNext default-import types (runtime is fine).
const Ajv2020 = Ajv2020Mod as unknown as { new (opts?: Record<string, unknown>): any };
const addFormats = addFormatsMod as unknown as (ajv: any) => void;

// Compiles a JSON Schema document into a `validate` function (ajv compile + the
// §5.2/§5.5/§5.11/§7.5 semantic checks below that the schema itself can't express).
// Exported so `schema-loader-node.ts` can bind the same validation logic to a
// different (OPENBODY_STANDARD-resolved) schema document without duplicating it.
export function createValidator(schemaDoc: unknown) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const _validate = ajv.compile(schemaDoc);

  return function validate(record: unknown): { valid: boolean; errors: string | null } {
    const ok = _validate(record);
    const phaseErrors = ok ? validateProgramPhases(record as Record<string, any>) : [];
    const semanticErrors = ok ? validateSemantics(record as Record<string, any>) : [];
    const valid = !!ok && phaseErrors.length === 0 && semanticErrors.length === 0;
    if (valid) return { valid: true, errors: null };
    const parts: string[] = [];
    if (!ok) parts.push(ajv.errorsText(_validate.errors, { separator: "; " }));
    parts.push(...phaseErrors, ...semanticErrors);
    return { valid: false, errors: parts.join("; ") };
  };
}

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

// Inline container fields by recordType (§5.1) — mirrors normalize.ts's CONTAINERS,
// duplicated locally so validate.ts stays independent of normalize.ts's internals.
// Program.sessions are refs (not inlined), so Program is not walked into.
const CONTAINERS: Record<string, string[]> = {
  Session: ["blocks", "exercises", "workUnits"],
  Block: ["children"],
  Exercise: ["workUnits"],
};

// Visit `rec` and every record inlined beneath it (§5.1 containment).
function forEachRecord(rec: any, visit: (r: Record<string, any>) => void): void {
  if (!rec || typeof rec !== "object") return;
  visit(rec);
  for (const field of CONTAINERS[rec.recordType] || []) {
    if (Array.isArray(rec[field])) for (const c of rec[field]) forEachRecord(c, visit);
  }
}

function isFixedPointWire(v: any): boolean {
  return v && typeof v === "object" && !Array.isArray(v) && "coefficient" in v && "exponent" in v;
}

// The discriminator key of a scalar-or-Target value (§5.10): "scalar" for a bare
// number/fixed-point, else the one Target variant key present (absolute/range/
// relativeToThreshold/stopCondition/ramp), ignoring the `extension` key (§5.10).
function targetVariant(v: any): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" || isFixedPointWire(v)) return "scalar";
  if (typeof v === "object") {
    for (const k of Object.keys(v)) if (k !== "extension") return k;
  }
  return undefined;
}

// §5.12 Load.unit conditional: required when `value` is a scalar or an
// absolute/range Target; MUST be omitted when `value` is relativeToThreshold or
// stopCondition (the unit derives from the resolved threshold, or doesn't apply).
// For absolute/range, the unit MAY instead live nested inside the Target itself
// (`value.absolute.unit` / `value.range.unit`) pre-normalization — EQUIVALENCE.md step 2
// folds it up to the sibling `Load.unit`, and both pre-fold locations are valid
// (proven by the load-range-unit-fold equivalence vector) — so either location
// satisfies "required" for those two variants. A bare scalar has no such inner
// slot, so `Load.unit` itself is the only place it can live.
// SPEC.md is silent on `ramp` here, so it is left unconstrained rather than guessed.
function checkLoadUnit(load: any, where: string): string[] {
  if (!load || typeof load !== "object") return [];
  const variant = targetVariant(load.value);
  if (variant === "scalar") {
    if (load.unit === undefined) {
      return [`${where}: Load.unit is required when value is a scalar (§5.12)`];
    }
  } else if (variant === "absolute" || variant === "range") {
    const nestedUnit = load.value[variant]?.unit;
    if (load.unit === undefined && nestedUnit === undefined) {
      return [`${where}: Load.unit is required when value is an ${variant} Target (unless nested inside value.${variant}.unit, folded on normalization) (§5.12; folded per EQUIVALENCE.md)`];
    }
  } else if (variant === "relativeToThreshold" || variant === "stopCondition") {
    if (load.unit !== undefined) {
      return [`${where}: Load.unit MUST be omitted when value is "${variant}" (§5.12)`];
    }
  }
  return [];
}

// §5.5 "scoring ↔ metric": a WorkUnit MUST NOT carry a metric field that
// contradicts its `scoring` kind — a reps-scored unit's primary metric is `reps`,
// time→time, distance→distance, energy→energy. `continuous` is the exception: it
// MAY carry any of distance/time/energy (no `reps`), with none required.
const SCORING_ALLOWED_METRICS: Record<string, string[]> = {
  reps: ["reps"],
  time: ["time"],
  distance: ["distance"],
  energy: ["energy"],
  continuous: ["distance", "time", "energy"],
};
const PRIMARY_METRIC_FIELDS = ["reps", "time", "distance", "energy"];

function checkScoringMetric(wu: Record<string, any>): string[] {
  const allowed = SCORING_ALLOWED_METRICS[wu.scoring];
  if (!allowed) return [];
  const errors: string[] = [];
  for (const side of ["prescription", "performance"] as const) {
    const obj = wu[side];
    if (!obj || typeof obj !== "object") continue;
    for (const f of PRIMARY_METRIC_FIELDS) {
      if (f in obj && !allowed.includes(f)) {
        errors.push(
          `WorkUnit ${wu.id ?? "?"} ${side}.${f} contradicts scoring:"${wu.scoring}" (§5.5)`,
        );
      }
    }
  }
  return errors;
}

// §5.5 "Sets shorthand": `sets` is a *planned prescription* shorthand that expands
// to N WorkUnits; the performed form MUST enumerate one WorkUnit per set, so a
// WorkUnit that carries `prescription.sets` MUST NOT also carry `performance`.
function checkSetsPerformance(wu: Record<string, any>): string[] {
  if (wu.prescription?.sets !== undefined && wu.performance !== undefined) {
    return [`WorkUnit ${wu.id ?? "?"} carries prescription.sets and performance — mutually exclusive (§5.5)`];
  }
  return [];
}

// §7.1/§7.5 tombstone: a `status: deleted` record is exempt from all otherwise-
// required fields, but on the wire it MUST carry strictly `id`/`recordType`/
// `status` — no other payload, link, or lifecycle field (§7.5: "an on-the-wire
// tombstone contains strictly the id, recordType, and status: deleted fields").
const TOMBSTONE_ALLOWED_FIELDS = new Set(["id", "recordType", "status"]);

function checkTombstone(rec: Record<string, any>): string[] {
  if (rec.status !== "deleted") return [];
  const extra = Object.keys(rec).filter((k) => !TOMBSTONE_ALLOWED_FIELDS.has(k));
  if (extra.length) {
    return [`tombstone ${rec.id ?? "?"} carries fields beyond id/recordType/status: ${extra.join(", ")} (§7.1/§7.5)`];
  }
  return [];
}

// §5.5 a WorkUnit's exerciseRef is mutually exclusive with an enclosing Exercise:
// Exercise.workUnits are always direct children (Exercise's only container, per
// CONTAINERS), so "enclosing" here is just "this Exercise's own workUnits array" —
// no recursive context-tracking needed.
function checkExerciseRefEnclosing(rec: Record<string, any>): string[] {
  if (rec.recordType !== "Exercise" || !Array.isArray(rec.workUnits)) return [];
  const errors: string[] = [];
  for (const wu of rec.workUnits) {
    if (wu && typeof wu === "object" && wu.exerciseRef !== undefined) {
      errors.push(
        `WorkUnit ${wu.id ?? "?"} carries exerciseRef but its enclosing Exercise ${rec.id ?? "?"} already carries one (§5.5)`,
      );
    }
  }
  return errors;
}

// §5.11 ThresholdProfileEntry.estimationFormula/estimatedFrom (OB-32) MUST NOT
// be present when `source` is "tested" — they document how an *estimate* was
// derived, so they're meaningless (and misleading) attached to a tested value.
function checkThresholdEstimationProvenance(rec: Record<string, any>): string[] {
  if (rec.recordType !== "ThresholdProfile" || !Array.isArray(rec.entries)) return [];
  const errors: string[] = [];
  rec.entries.forEach((entry: any, i: number) => {
    if (!entry || typeof entry !== "object" || entry.source !== "tested") return;
    if (entry.estimationFormula !== undefined) {
      errors.push(`ThresholdProfile ${rec.id ?? "?"} entries[${i}]: estimationFormula MUST NOT be present when source is "tested" (§5.11)`);
    }
    if (entry.estimatedFrom !== undefined) {
      errors.push(`ThresholdProfile ${rec.id ?? "?"} entries[${i}]: estimatedFrom MUST NOT be present when source is "tested" (§5.11)`);
    }
  });
  return errors;
}

// Intra-record semantic rules the schema can't express (context-dependent, not a
// fixed shape): Load.unit's conditional requirement, scoring↔metric agreement,
// sets+performance mutual exclusion, the tombstone-only-field rule,
// exerciseRef/enclosing-Exercise mutual exclusion, and estimation-provenance
// gating on ThresholdProfileEntry.source. Walks the whole inlined-record tree
// under `record` (§5.1), not just the top-level record.
function validateSemantics(record: Record<string, any>): string[] {
  const errors: string[] = [];
  forEachRecord(record, (rec) => {
    errors.push(...checkTombstone(rec));
    errors.push(...checkExerciseRefEnclosing(rec));
    errors.push(...checkThresholdEstimationProvenance(rec));
    if (rec.recordType === "WorkUnit") {
      if (rec.prescription?.load) {
        errors.push(...checkLoadUnit(rec.prescription.load, `WorkUnit ${rec.id ?? "?"} prescription.load`));
      }
      if (rec.performance?.load) {
        errors.push(...checkLoadUnit(rec.performance.load, `WorkUnit ${rec.id ?? "?"} performance.load`));
      }
      errors.push(...checkScoringMetric(rec));
      errors.push(...checkSetsPerformance(rec));
    }
  });
  return errors;
}

// Default, browser-safe export: bound to the vendored schema snapshot at module load.
export const validate = createValidator(schema);
