// Conformance vector suite: the standard's vectors + activity-coverage corpus run
// against this implementation (SPEC §8.3). Same logic as `npm run vectors` — both go
// through src/vector-runner-node.ts. Skips LOUDLY when the sibling `openbody`
// checkout (or OPENBODY_STANDARD) is absent instead of failing.
import { describe, expect, it } from "vitest";
import { discoverVectorFiles, runVectorFile, standardDir } from "../src/vector-runner-node.js";

const files = discoverVectorFiles();

if (files.length === 0) {
  const msg = `⚠ SKIPPING conformance vectors — no vectors found under ${standardDir} (checkout the openbody repo as a sibling or set OPENBODY_STANDARD)`;
  console.warn(msg);
  process.stderr.write(`${msg}\n`); // vitest swallows module-scope console output; stderr stays visible
  it.skip(`SKIPPED LOUDLY: conformance vectors (standard checkout absent: ${standardDir})`, () => {});
} else {
  describe("conformance vectors + corpus", () => {
    it("discovers both suites (vectors + corpus)", () => {
      expect(files.some((f) => f.label === "vectors")).toBe(true);
      expect(files.some((f) => f.label === "corpus")).toBe(true);
    });

    it.each(files.map((f) => [`${f.label}/${f.file}`, f] as const))("%s", (_, f) => {
      const r = runVectorFile(f.dir, f.file);
      expect(r.ok, `${r.name}${r.detail ? ` — ${r.detail}` : ""}`).toBe(true);
    });
  });
}
