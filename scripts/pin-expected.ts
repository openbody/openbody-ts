// Utility: pin the exact `expected` canonical form onto each `normalization` vector
// using this reference implementation (which is the authority that fixes the bytes,
// SPEC §8.3). Re-run when the spec/normalizer changes; review the diff.
import fs from "node:fs";
import path from "node:path";
import { normalizeDocument } from "../src/normalize.js";
import { standardDir } from "../src/validate.js";
import { parseLossless } from "../src/parse.js";

const vdir = path.join(standardDir, "conformance/vectors");
let pinned = 0;
for (const f of fs.readdirSync(vdir).sort()) {
  if (!f.endsWith(".json") || f === "index.json") continue;
  const p = path.join(vdir, f);
  const text = fs.readFileSync(p, "utf8");
  const v = JSON.parse(text);
  if (v.kind !== "normalization") continue;
  // Normalize from the lossless parse (matches the runner; §8.3 step 1).
  const input = (parseLossless(text) as any).input;
  v.expected = normalizeDocument(input);
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
  console.log(`pinned ${f} (${v.expected.length} records)`);
  pinned++;
}
console.log(`done — ${pinned} normalization vector(s) pinned.`);
