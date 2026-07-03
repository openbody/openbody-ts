// Conformance vector runner — thin CLI over src/vector-runner-node.ts (the same
// logic the vitest suite runs in test/conformance.test.ts). `npm run vectors`.
import { discoverVectorFiles, runVectorFile, standardDir } from "../src/vector-runner-node.js";

const files = discoverVectorFiles();

let pass = 0;
let fail = 0;
const fails: string[] = [];

console.log(`OpenBody-TS conformance run (standard: ${standardDir})\n`);
let lastLabel = "";
for (const { label, dir, file } of files) {
  if (label !== lastLabel) { console.log(`\n# ${label}`); lastLabel = label; }
  const r = runVectorFile(dir, file);
  if (r.ok) { pass++; console.log(`  ok   ${r.name}${r.detail ? ` ${r.detail}` : ""}`); }
  else { fail++; fails.push(`${r.name}: ${r.detail}`); console.log(`  FAIL ${r.name} — ${r.detail}`); }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail || files.length === 0) {
  if (files.length === 0) console.error(`no vectors found under ${standardDir} — set OPENBODY_STANDARD to the openbody checkout`);
  process.exit(1);
}
