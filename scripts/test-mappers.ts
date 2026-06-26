// Mapper SDK round-trip tests: for each incumbent sample, map → wire records, assert
// every record validates against the schema, and assert §8.3 normalization round-trips
// (normalizing the canonical output again yields the same set). D1 / OB-3.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/validate.js";
import { normalizeDocument } from "../src/normalize.js";
import { mapHevy, mapStrong, mapStrava, mapAppleHealth } from "../src/mappers/index.js";

const ex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples");
const read = (p: string) => fs.readFileSync(path.join(ex, p), "utf8");

const cases: { name: string; records: Record<string, any>[] }[] = [
  { name: "hevy", records: mapHevy(read("hevy/hevy-sample.csv")) },
  { name: "strong", records: mapStrong(read("strong/strong-sample.csv")) },
  { name: "strava", records: mapStrava(JSON.parse(read("strava/strava-sample.json"))) },
  { name: "apple-health", records: mapAppleHealth(read("apple-health/export-sample.xml")) },
];

let fail = 0;
for (const c of cases) {
  const errs: string[] = [];
  if (c.records.length === 0) errs.push("mapped 0 records");
  for (const r of c.records) {
    const v = validate(r);
    if (!v.valid) errs.push(`wire ${r.recordType} ${r.id}: ${v.errors}`);
  }
  // round-trip: normalize, re-parse the canonical bytes, normalize again — must match.
  const n1 = normalizeDocument(c.records);
  const n2 = normalizeDocument(n1.map((s) => JSON.parse(s)));
  if (!(n1.length === n2.length && n1.every((s, i) => s === n2[i]))) errs.push("normalization not idempotent (round-trip)");

  if (errs.length) { fail++; console.log(`  FAIL ${c.name}\n${errs.map((e) => "       - " + e).join("\n")}`); }
  else console.log(`  ok   ${c.name} — ${c.records.length} wire records validate; ${n1.length} canonical (round-trip stable)`);
}

console.log(`\n${cases.length - fail}/${cases.length} mappers pass`);
if (fail) process.exit(1);
