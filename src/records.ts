// Structural record facts shared by normalize.ts and validate.ts (previously
// duplicated in both with a drift hazard). Browser-safe: pure data, no imports;
// internal — not re-exported from the package entry (src/index.ts).

// Inline container fields by recordType (§5.1 containment). Program.sessions are
// refs (not inlined) — Program is never walked into; WorkUnit.repDetail are
// sub-objects (not records) — not flattened either.
export const CONTAINERS: Record<string, string[]> = {
  Session: ["blocks", "exercises", "workUnits"],
  Block: ["children"],
  Exercise: ["workUnits"],
};
