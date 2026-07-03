// OB-81 breadth-proof mapper tests: Concept2 Logbook (rowing) + theCrag (climbing).
// Self-contained (imports the mappers directly, not via src/mappers/index.ts):
//   - every mapped record validates against the schema, and normalization round-trips;
//   - the Concept2 interval workout expands to a Block of per-interval WorkUnits with rest;
//   - theCrag ascent types produce the outcome encodings documented in thecrag.ts
//     (canonical corpus encoding: climbing-send-attempt.valid.json / §5.18);
//   - every canonical exerciseRef id the two mappers emit exists in the registry
//     (../openbody-registry/data/exercises.json, override with OPENBODY_REGISTRY).
// Run: npx tsx scripts/test-concept2-thecrag.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/schema-loader-node.js";
import { normalizeDocument } from "../src/normalize.js";
import { mapConcept2 } from "../src/mappers/concept2.js";
import { mapTheCrag } from "../src/mappers/thecrag.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(root, "examples", p), "utf8");

const c2 = mapConcept2(read("concept2/concept2-season-sample.csv"));
const crag = mapTheCrag(read("thecrag/thecrag-sample.csv"));

let fail = 0;
let total = 0;
const check = (name: string, errs: string[], okDetail: string) => {
  total++;
  if (errs.length) { fail++; console.log(`  FAIL ${name}\n${errs.map((e) => "       - " + e).join("\n")}`); }
  else console.log(`  ok   ${name} — ${okDetail}`);
};

// 1) Schema validation + §8.3 normalization round-trip for both mappers.
for (const [name, records] of [["concept2", c2], ["thecrag", crag]] as const) {
  const errs: string[] = [];
  if (records.length === 0) errs.push("mapped 0 records");
  for (const r of records) {
    const v = validate(r);
    if (!v.valid) errs.push(`wire ${r.recordType} ${r.id}: ${v.errors}`);
  }
  const n1 = normalizeDocument(records);
  const n2 = normalizeDocument(n1.map((s) => JSON.parse(s)));
  if (!(n1.length === n2.length && n1.every((s, i) => s === n2[i]))) errs.push("normalization not idempotent (round-trip)");
  check(name, errs, `${records.length} wire records validate; ${n1.length} canonical (round-trip stable)`);
}

// 2) Concept2 structure: piece scoring inference, interval Block + rest, HR measurement,
//    stroke-rate intensity home, machine-type mapping.
{
  const errs: string[] = [];
  const sess = (name: string) => c2.find((r) => r.recordType === "Session" && r.name === name);

  // Fixed-distance piece: distance-scored; elapsed time preserved as residue; stroke
  // rate + watts as achieved intensity (§5.13); avg HR measuredBy-linked Measurement.
  const twoK = sess("2000m row");
  const twoKwu = twoK?.workUnits?.[0];
  if (twoKwu?.scoring !== "distance") errs.push(`2000m: scoring ${twoKwu?.scoring}, want distance`);
  if (twoKwu?.performance?.distance?.absolute?.value !== 2000) errs.push(`2000m: distance ${JSON.stringify(twoKwu?.performance?.distance)}`);
  if (twoKwu?.performance?.time !== undefined) errs.push("2000m: distance-scored unit must not carry a time metric (§5.5)");
  if (twoK?.extension?.concept2?.workTimeSeconds !== 465.3) errs.push(`2000m: residue workTimeSeconds ${twoK?.extension?.concept2?.workTimeSeconds}`);
  const cad = twoKwu?.performance?.intensity?.find((x: any) => x.dimension === "cadence");
  if (cad?.value?.absolute?.value !== 28 || cad?.unit !== "/min") errs.push(`2000m: cadence intensity ${JSON.stringify(cad)}`);
  const pow = twoKwu?.performance?.intensity?.find((x: any) => x.dimension === "power");
  if (pow?.value?.absolute?.value !== 221) errs.push(`2000m: power intensity ${JSON.stringify(pow)}`);
  if (twoKwu?.exerciseRef?.id !== "row.erg") errs.push(`2000m: exerciseRef ${JSON.stringify(twoKwu?.exerciseRef)}`);
  if (JSON.stringify(twoK?.disciplines) !== '["rowing"]') errs.push(`2000m: disciplines ${JSON.stringify(twoK?.disciplines)}`);
  const hr = c2.find((r) => r.recordType === "Measurement" && r.id === `${twoK?.id}-hr`);
  if (hr?.type !== "heart_rate_mean" || hr?.quantity !== 172 || hr?.unit !== "/min") errs.push(`2000m: HR measurement ${JSON.stringify(hr)}`);
  if (!twoK?.links?.some((l: any) => l.type === "measuredBy" && l.ref === hr?.id)) errs.push("2000m: Session missing measuredBy link to the HR measurement");
  // The Date column is offset-less wall-clock time — the mapped instant (and the HR
  // measurement window) must be the same on every host TZ (parsed manually, stamped "Z").
  if (twoK?.startTime !== "2026-03-02T06:45:00Z" || twoK?.endTime !== "2026-03-02T06:52:45Z") errs.push(`2000m: window ${twoK?.startTime}..${twoK?.endTime}, want 06:45:00Z..06:52:45Z regardless of host TZ`);
  if (hr?.startTime !== "2026-03-02T06:45:00Z") errs.push(`2000m: HR window startTime ${hr?.startTime} not TZ-independent`);

  // Fixed-time piece on the SkiErg: time-scored; skierg discipline namespaced; ski.erg id.
  const thirty = sess("30:00 SkiErg");
  const thirtyWu = thirty?.workUnits?.[0];
  if (thirtyWu?.scoring !== "time" || thirtyWu?.performance?.time?.absolute?.value !== 1800) errs.push(`30:00: ${JSON.stringify(thirtyWu?.performance?.time)} scoring ${thirtyWu?.scoring}`);
  if (thirtyWu?.exerciseRef?.id !== "ski.erg") errs.push(`30:00: exerciseRef ${JSON.stringify(thirtyWu?.exerciseRef)}`);
  if (JSON.stringify(thirty?.disciplines) !== '["concept2:skierg"]') errs.push(`30:00: disciplines ${JSON.stringify(thirty?.disciplines)}`);

  // "Just row": continuous, carries time + distance + energy; no HR column ⇒ no Measurement.
  const jr = sess("2:37 row");
  const jrWu = jr?.workUnits?.[0];
  if (jrWu?.scoring !== "continuous") errs.push(`just row: scoring ${jrWu?.scoring}, want continuous`);
  if (jrWu?.performance?.time?.absolute?.value !== 157.4 || jrWu?.performance?.distance?.absolute?.value !== 610) errs.push(`just row: ${JSON.stringify(jrWu?.performance)}`);
  if (c2.some((r) => r.recordType === "Measurement" && r.id === `${jr?.id}-hr`)) errs.push("just row: HR measurement emitted with no Avg Heart Rate");

  check("concept2 pieces (fixed-distance / fixed-time / just-row)", errs,
    "scoring inferred per row; stroke rate+watts as §5.13 intensity; avg HR as measuredBy-linked Measurement");
}
{
  const errs: string[] = [];
  const sess = (name: string) => c2.find((r) => r.recordType === "Session" && r.name === name);

  // 8x500m/0:30r ⇒ Block of 8 distance-scored 500 m WorkUnits, each with 30 s rest.
  const iv = sess("8x500m/0:30r row");
  const kids = iv?.blocks?.[0]?.children ?? [];
  if (iv?.blocks?.length !== 1 || kids.length !== 8) errs.push(`8x500m: expected 1 Block × 8 children, got ${iv?.blocks?.length} × ${kids.length}`);
  for (const k of kids) {
    if (k.recordType !== "WorkUnit" || k.scoring !== "distance") { errs.push(`8x500m child: ${k.recordType}/${k.scoring}`); break; }
    if (k.performance?.distance?.absolute?.value !== 500) { errs.push(`8x500m child distance: ${JSON.stringify(k.performance?.distance)}`); break; }
    if (k.performance?.rest?.absolute?.value !== 30) { errs.push(`8x500m child rest: ${JSON.stringify(k.performance?.rest)}`); break; }
    if (k.exerciseRef?.id !== "row.erg") { errs.push(`8x500m child exerciseRef: ${JSON.stringify(k.exerciseRef)}`); break; }
  }
  if (iv?.extension?.concept2?.avgStrokeRate !== 30) errs.push(`8x500m: whole-workout stroke rate should be residue, got ${JSON.stringify(iv?.extension)}`);

  // 4x5:00/1:00r ⇒ 4 time-scored 300 s children with 60 s rest.
  const tv = sess("4x5:00/1:00r row");
  const tkids = tv?.blocks?.[0]?.children ?? [];
  if (tkids.length !== 4) errs.push(`4x5:00: expected 4 children, got ${tkids.length}`);
  if (tkids[0]?.scoring !== "time" || tkids[0]?.performance?.time?.absolute?.value !== 300) errs.push(`4x5:00 child: ${JSON.stringify(tkids[0]?.performance)}`);
  if (tkids[3]?.performance?.rest?.absolute?.value !== 60) errs.push(`4x5:00 child rest: ${JSON.stringify(tkids[3]?.performance?.rest)}`);

  // Variable intervals: the season CSV only discloses the first interval + count, so it
  // degrades to a single continuous WorkUnit with the rest totals as residue.
  const vv = sess("v2000m/3:00r...3 BikeErg");
  if (vv?.blocks !== undefined) errs.push("v-intervals: must not fabricate a per-interval Block from the season CSV");
  const vwu = vv?.workUnits?.[0];
  if (vwu?.scoring !== "continuous" || vwu?.performance?.distance?.absolute?.value !== 6000) errs.push(`v-intervals: ${JSON.stringify(vwu?.performance)}`);
  if (vv?.extension?.concept2?.restTimeSeconds !== 540) errs.push(`v-intervals: residue restTimeSeconds ${vv?.extension?.concept2?.restTimeSeconds}`);
  if (JSON.stringify(vv?.disciplines) !== '["cycling"]') errs.push(`BikeErg disciplines: ${JSON.stringify(vv?.disciplines)}`);
  if (vwu?.exerciseRef?.id !== undefined || vwu?.exerciseRef?.opaque !== "BikeErg") errs.push(`BikeErg exerciseRef (no canonical id): ${JSON.stringify(vwu?.exerciseRef)}`);

  check("concept2 intervals (Block + per-interval rest; v-intervals degrade)", errs,
    "8x500m/0:30r → Block×8 with rest 30 s; 4x5:00/1:00r → Block×4 with rest 60 s; v… stays a single continuous unit");
}

// 3) theCrag: session grouping + the documented Ascent Type → outcome table +
//    Gear Style → exerciseRef ladder + grade-as-modifier + route name in notes.
{
  const errs: string[] = [];
  if (crag.length !== 2) errs.push(`expected 2 sessions (2 date+crag groups), got ${crag.length}`);
  const wus = crag.flatMap((s) => s.workUnits ?? []);
  const byRoute = (name: string) => wus.find((w) => typeof w.notes === "string" && w.notes.startsWith(name));

  const expectOutcome = (route: string, wu: any, value: boolean | undefined, attempts: { made: number; attempted: number } | undefined) => {
    if (!wu) return errs.push(`${route}: no WorkUnit found (route name must lead the notes)`);
    const o = wu.performance?.outcome;
    if (value === undefined) { if (o !== undefined) errs.push(`${route}: expected no outcome, got ${JSON.stringify(o)}`); return; }
    if (o?.kind !== "success" || o?.value !== value) errs.push(`${route}: outcome ${JSON.stringify(o)}, want success/${value}`);
    if (JSON.stringify(o?.attempts) !== JSON.stringify(attempts)) errs.push(`${route}: attempts ${JSON.stringify(o?.attempts)}, want ${JSON.stringify(attempts)}`);
  };

  // Onsight / Flash ⇒ success on the first try (attempts 1/1) — §5.18's named case.
  expectOutcome("The Bard", byRoute("The Bard"), true, { made: 1, attempted: 1 });
  expectOutcome("Sleepy Hollow", byRoute("Sleepy Hollow"), true, { made: 1, attempted: 1 });
  // Red point / Send / Top rope clean / Second clean ⇒ success, prior tries unknown.
  expectOutcome("Kachoong", byRoute("Kachoong"), true, undefined);
  expectOutcome("Cave Man", byRoute("Cave Man"), true, undefined);
  expectOutcome("Muldoon", byRoute("Muldoon"), true, undefined);
  expectOutcome("Tiptoe Ridge", byRoute("Tiptoe Ridge"), true, undefined);
  // Attempt / Hang dog / Dab ⇒ not sent (made 0 of 1).
  expectOutcome("Punks in the Gym", byRoute("Punks in the Gym"), false, { made: 0, attempted: 1 });
  expectOutcome("India", byRoute("India"), false, { made: 0, attempted: 1 });
  expectOutcome("Wheel of Life", byRoute("Wheel of Life"), false, { made: 0, attempted: 1 });
  expectOutcome("Rock Ape", byRoute("Rock Ape"), false, { made: 0, attempted: 1 });

  const expectRef = (route: string, id: string) => {
    const wu = byRoute(route);
    if (wu?.exerciseRef?.id !== id) errs.push(`${route}: exerciseRef ${JSON.stringify(wu?.exerciseRef)}, want id ${id}`);
  };
  expectRef("The Bard", "climb.route.lead"); // Trad, led
  expectRef("Kachoong", "climb.route.lead"); // Sport, led
  expectRef("Muldoon", "climb.route.top-rope"); // Ascent Gear Style "Top rope"
  expectRef("Tiptoe Ridge", "climb.route.top-rope"); // "Second clean" follows on the rope
  expectRef("Cave Man", "climb.boulder");

  // Canonical corpus encoding details: reps-scored, reps 1, grade as a modifiers token.
  for (const w of wus) {
    if (w.scoring !== "reps" || w.performance?.reps !== 1) { errs.push(`${w.id}: not a reps-scored single-try unit`); break; }
  }
  const wheel = byRoute("Wheel of Life");
  if (JSON.stringify(wheel?.performance?.modifiers) !== JSON.stringify([{ type: "grade", value: "V10" }]))
    errs.push(`Wheel of Life: modifiers ${JSON.stringify(wheel?.performance?.modifiers)} (Ascent Grade must win over Route Grade)`);
  if (!byRoute("Kachoong")?.notes?.includes("Finally!")) errs.push("Kachoong: comment not carried into notes");
  const day1 = crag.find((s) => s.name === "Arapiles"), day2 = crag.find((s) => s.name === "Hollow Mountain Cave");
  if (day1?.startTime !== "2026-05-16T00:00:00Z") errs.push(`Arapiles startTime ${day1?.startTime} — an offset-carrying Ascent Date must pass through untouched by the host TZ`);
  if (JSON.stringify(day1?.disciplines) !== '["climbing"]') errs.push(`Arapiles disciplines: ${JSON.stringify(day1?.disciplines)}`);
  if (JSON.stringify(day2?.disciplines) !== '["bouldering"]') errs.push(`boulder-day disciplines: ${JSON.stringify(day2?.disciplines)}`);
  if (day1?.workUnits?.length !== 6 || day2?.workUnits?.length !== 4) errs.push(`grouping: ${day1?.workUnits?.length}+${day2?.workUnits?.length} ascents, want 6+4`);

  check("thecrag ascent types → outcome/exerciseRef (documented table)", errs,
    "onsight/flash 1-of-1; redpoint/clean success sans attempts; attempt/dog/dab 0-of-1; gear style picks climb.* id");
}

// 4) Every canonical exerciseRef id emitted by the two mappers exists in the registry.
{
  const errs: string[] = [];
  const regPath = process.env.OPENBODY_REGISTRY
    ? path.resolve(process.env.OPENBODY_REGISTRY, "data/exercises.json")
    : path.resolve(root, "../openbody-registry/data/exercises.json");
  if (!fs.existsSync(regPath)) check("registry ids", [`registry not found at ${regPath} (set OPENBODY_REGISTRY)`], "");
  else {
    const known = new Set((JSON.parse(fs.readFileSync(regPath, "utf8")) as { id: string }[]).map((e) => e.id));
    const ids = new Set<string>();
    const walk = (o: any): void => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === "object") {
        if (o.exerciseRef) { const id = typeof o.exerciseRef === "string" ? o.exerciseRef : o.exerciseRef.id; if (id) ids.add(id); }
        Object.values(o).forEach(walk);
      }
    };
    walk([...c2, ...crag]);
    for (const id of ids) if (!known.has(id)) errs.push(`exerciseRef id "${id}" not in the registry`);
    if (![...ids].some((i) => i.startsWith("climb."))) errs.push("no climb.* ids emitted at all");
    check("registry ids", errs, `${ids.size} distinct canonical ids all present in exercises.json (${[...ids].sort().join(", ")})`);
  }
}

console.log(`\n${total - fail}/${total} concept2+thecrag checks pass`);
if (fail) process.exit(1);
