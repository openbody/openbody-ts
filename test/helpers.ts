// Shared fixture + assertion helpers for the vitest suite. Uses the Node-only
// schema loader (OPENBODY_STANDARD-aware) exactly like the tsx scripts it replaced.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { normalizeDocument } from "../src/normalize.js";
import { validate } from "../src/schema-loader-node.js";
import type { OpenBodyRecord } from "../src/types.js";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const examplesDir = path.join(repoRoot, "examples");

/** Read a fixture from examples/ (e.g. "hevy/hevy-sample.csv"). */
export const readExample = (p: string): string => fs.readFileSync(path.join(examplesDir, p), "utf8");

export { validate };

/** Every wire record schema-validates. */
export function expectAllValid(records: OpenBodyRecord[]): void {
  for (const r of records) {
    const v = validate(r);
    expect(v.valid, `wire ${r.recordType} ${r.id}: ${v.errors}`).toBe(true);
  }
}

/** §8.3 round-trip: normalize, re-parse the canonical bytes, normalize again — must match. */
export function expectRoundTripStable(records: OpenBodyRecord[]): string[] {
  const n1 = normalizeDocument(records as any);
  const n2 = normalizeDocument(n1.map((s) => JSON.parse(s)));
  expect(n2, "normalization not idempotent (round-trip)").toEqual(n1);
  return n1;
}

/** The standard bar every mapper output must clear (schema + round-trip). */
export function expectValidAndStable(records: OpenBodyRecord[]): string[] {
  expect(records.length, "mapped 0 records").toBeGreaterThan(0);
  expectAllValid(records);
  return expectRoundTripStable(records);
}

/** Path to the sibling openbody-registry checkout's exercises.json (OPENBODY_REGISTRY-aware). */
export const registryExercisesPath = process.env.OPENBODY_REGISTRY
  ? path.resolve(process.env.OPENBODY_REGISTRY, "data/exercises.json")
  : path.resolve(repoRoot, "../openbody-registry/data/exercises.json");

export const haveRegistry = fs.existsSync(registryExercisesPath);
if (!haveRegistry) {
  const msg = `⚠ SKIPPING registry-backed assertions — openbody-registry checkout not found at ${registryExercisesPath} (set OPENBODY_REGISTRY)`;
  console.warn(msg);
  process.stderr.write(`${msg}\n`); // vitest swallows module-scope console output; stderr stays visible
}

/** Collect every exerciseRef id in a mapped document (string or object form). */
export function collectExerciseRefIds(records: OpenBodyRecord[]): Set<string> {
  const ids = new Set<string>();
  const walk = (o: any): void => {
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    if (o && typeof o === "object") {
      if (o.exerciseRef) {
        const id = typeof o.exerciseRef === "string" ? o.exerciseRef : o.exerciseRef.id;
        if (id) ids.add(id);
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(records);
  return ids;
}
