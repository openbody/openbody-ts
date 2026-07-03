// Mapper SDK round-trip tests: for each incumbent sample, map → wire records, assert
// every record validates against the schema, and assert §8.3 normalization round-trips
// (normalizing the canonical output again yields the same set). D1 / OB-3.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/schema-loader-node.js";
import { normalizeDocument, equivalent } from "../src/normalize.js";
import { mapHevy, mapStrong, mapStrava, mapAppleHealth, mapFit, mapOpenBodyToStrong, parseCsv } from "../src/mappers/index.js";

const ex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples");
const read = (p: string) => fs.readFileSync(path.join(ex, p), "utf8");

const cases: { name: string; records: Record<string, any>[] }[] = [
  { name: "hevy", records: mapHevy(read("hevy/hevy-sample.csv")) },
  { name: "strong", records: mapStrong(read("strong/strong-sample.csv")) },
  { name: "strava", records: mapStrava(JSON.parse(read("strava/strava-sample.json"))) },
  { name: "apple-health", records: mapAppleHealth(read("apple-health/export-sample.xml")) },
  { name: "fit-activity", records: mapFit(JSON.parse(read("fit/fit-activity-sample.json"))) },
  { name: "fit-workout", records: mapFit(JSON.parse(read("fit/fit-workout-sample.json"))) },
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

// Outbound round-trip: mapOpenBodyToStrong is the mirror of mapStrong. It now covers the
// full fixture — including the Plank duration-scored row — with zero omissions.
let total = cases.length;
{
  const name = "to-strong (outbound)";
  total++;
  const errs: string[] = [];
  const original = mapStrong(read("strong/strong-sample.csv"));
  const out = mapOpenBodyToStrong(original);
  const roundTripped = mapStrong(out.csv);

  if (original.length === 0) errs.push("fixture mapped 0 records");
  if (out.omissions.length) errs.push(`expected 0 omissions for the Strong fixture, got: ${JSON.stringify(out.omissions)}`);
  for (const r of roundTripped) {
    const v = validate(r);
    if (!v.valid) errs.push(`round-tripped wire ${r.recordType} ${r.id}: ${v.errors}`);
  }
  if (!equivalent(original, roundTripped)) errs.push("outbound round-trip (Strong → OpenBody → Strong → OpenBody) not equivalent");
  // The duration-scored Plank row must survive: Seconds column carries the hold time.
  const plank = parseCsv(out.csv).find((r) => r["Exercise Name"] === "Plank");
  if (plank?.Seconds !== "60") errs.push(`Plank duration set: expected Seconds=60, got ${JSON.stringify(plank)}`);

  if (errs.length) { fail++; console.log(`  FAIL ${name}\n${errs.map((e) => "       - " + e).join("\n")}`); }
  else console.log(`  ok   ${name} — ${original.length} session(s) incl. a duration set round-trip through Strong CSV, 0 omissions`);
}

// Outbound coverage: what Strong's CSV can hold (duration/distance/bodyweight/kg-conversion/
// RPE) maps faithfully; what it can't (supersets, %1RM) degrades per the documented policy
// into a machine-readable omissions report — and `{ strict: true }` throws instead.
{
  const name = "to-strong coverage + degradation policy";
  total++;
  const errs: string[] = [];
  const session = (over: Record<string, any>): Record<string, any> => ({
    id: "s1", recordType: "Session", subject: "subj-001", disciplines: ["strength"],
    startTime: "2026-01-01T10:00:00Z", endTime: "2026-01-01T11:00:00Z", name: "Test", ...over,
  });
  const exercise = (workUnits: Record<string, any>[], id = "e1"): Record<string, any> =>
    ({ id, recordType: "Exercise", exerciseRef: { opaque: "Some Movement" }, workUnits });
  const row = (records: Record<string, any>[]) => {
    const out = mapOpenBodyToStrong(records);
    return { ...out, rows: parseCsv(out.csv) };
  };

  // duration set: explicit non-second unit converts exactly (2 min → 120 s).
  const dur = row([session({ exercises: [exercise([{ id: "w1", recordType: "WorkUnit", scoring: "time", performance: { time: { absolute: { value: 2, unit: "min" } } } }])] })]);
  if (dur.rows[0]?.Seconds !== "120" || dur.omissions.length) errs.push(`duration set: Seconds=${dur.rows[0]?.Seconds}, omissions=${dur.omissions.length}`);

  // distance set: km → Strong's metres, exact decimal shift (5.3 km → 5300, no float dust);
  // round-trips through mapStrong as { value: 5300, unit: "m" }.
  const dist = row([session({ exercises: [exercise([{ id: "w1", recordType: "WorkUnit", scoring: "distance", performance: { distance: { absolute: { value: 5.3, unit: "km" } } } }])] })]);
  if (dist.rows[0]?.Distance !== "5300" || dist.omissions.length) errs.push(`distance set: Distance=${dist.rows[0]?.Distance} (want 5300), omissions=${dist.omissions.length}`);
  const distBack = mapStrong(dist.csv)[0]?.exercises?.[0]?.workUnits?.[0]?.performance?.distance;
  if (JSON.stringify(distBack) !== JSON.stringify({ absolute: { value: 5300, unit: "m" } })) errs.push(`distance re-import: ${JSON.stringify(distBack)}`);

  // bodyweight / reps-only set: Reps carried, Weight stays 0, no load on re-import.
  const bw = row([session({ exercises: [exercise([{ id: "w1", recordType: "WorkUnit", scoring: "reps", performance: { reps: 12 } }])] })]);
  if (bw.rows[0]?.Reps !== "12" || bw.rows[0]?.Weight !== "0" || bw.omissions.length) errs.push(`bodyweight set: ${JSON.stringify(bw.rows[0])}, omissions=${bw.omissions.length}`);
  if (mapStrong(bw.csv)[0]?.exercises?.[0]?.workUnits?.[0]?.performance?.load !== undefined) errs.push("bodyweight set: re-import grew a load");

  // kg conversion: [lb_av] → kg with exact decimal math (225 lb → 102.05828325 kg).
  const lb = row([session({ exercises: [exercise([{ id: "w1", recordType: "WorkUnit", scoring: "reps", performance: { reps: 5, load: { value: 225, unit: "[lb_av]", basis: "marked_weight" } } }])] })]);
  if (lb.rows[0]?.Weight !== "102.05828325" || lb.omissions.length) errs.push(`lb→kg: Weight=${lb.rows[0]?.Weight} (want 102.05828325), omissions=${lb.omissions.length}`);

  // RPE where present → the RPE column.
  const rpe = row([session({ exercises: [exercise([{ id: "w1", recordType: "WorkUnit", scoring: "reps", performance: { reps: 5, effortLoad: [{ kind: "internal", method: "RPE", value: 8.5 }] } }])] })]);
  if (rpe.rows[0]?.RPE !== "8.5" || rpe.omissions.length) errs.push(`RPE: ${rpe.rows[0]?.RPE}, omissions=${rpe.omissions.length}`);

  // Session.workUnits (the collapsed §5.1 hierarchy strava/fit/tcx/gpx/concept2/thecrag
  // produce): a unit naming its own exercise emits a row; a ref-less one has no Exercise
  // Name to write and must land in the omissions report, not vanish silently.
  const wus = row([session({ workUnits: [
    { id: "wu1", recordType: "WorkUnit", exerciseRef: { opaque: "RowErg" }, scoring: "time", performance: { time: { absolute: { value: 300, unit: "s" } } } },
    { id: "wu2", recordType: "WorkUnit", scoring: "continuous", performance: { distance: { absolute: { value: 5000, unit: "m" } } } },
  ] })]);
  if (wus.rows.length !== 1 || wus.rows[0]?.["Exercise Name"] !== "RowErg" || wus.rows[0]?.Seconds !== "300")
    errs.push(`session.workUnits row: ${JSON.stringify(wus.rows[0])}`);
  if (!wus.omissions.some((o) => o.recordId === "wu2" && o.field === "exerciseRef"))
    errs.push(`ref-less session.workUnit not reported as an omission: ${JSON.stringify(wus.omissions)}`);

  // omissions: a superset Block flattens to plain sets (both rows emitted) and a %1RM load
  // has no absolute kg value — both reported with recordIds, neither fatal.
  const lossy = [session({
    blocks: [{
      id: "blk1", recordType: "Block", grouping: "superset",
      children: [
        exercise([{ id: "w1", recordType: "WorkUnit", scoring: "reps", performance: { reps: 5, load: { value: { relativeToThreshold: { percent: 80, of: "1RM" } }, basis: "marked_weight" } } }], "e1"),
        exercise([{ id: "w2", recordType: "WorkUnit", scoring: "reps", performance: { reps: 10 } }], "e2"),
      ],
    }],
  })];
  const deg = row(lossy);
  if (deg.rows.length !== 2) errs.push(`superset flatten: expected 2 rows, got ${deg.rows.length}`);
  if (!deg.omissions.some((o) => o.recordId === "blk1" && o.field === "grouping")) errs.push(`no grouping omission: ${JSON.stringify(deg.omissions)}`);
  if (!deg.omissions.some((o) => o.recordId === "w1" && o.field === "load")) errs.push(`no %1RM load omission: ${JSON.stringify(deg.omissions)}`);
  if (deg.rows[0]?.Weight !== "0" || deg.rows[0]?.Reps !== "5") errs.push(`%1RM set should keep reps, zero weight: ${JSON.stringify(deg.rows[0])}`);

  // strict mode: the same document throws instead of degrading.
  let threw = false;
  try { mapOpenBodyToStrong(lossy, { strict: true }); } catch { threw = true; }
  if (!threw) errs.push("strict mode did not throw on a lossy document");

  if (errs.length) { fail++; console.log(`  FAIL ${name}\n${errs.map((e) => "       - " + e).join("\n")}`); }
  else console.log(`  ok   ${name} — duration/distance/bodyweight/lb→kg/RPE map; workUnits emit/report; superset+%1RM degrade with ${deg.omissions.length} reported omissions; strict throws`);
}

// Timezone independence + stable ids: offset-less CSV wall-clock timestamps must map to the
// SAME UTC instant on every host TZ (run the suite under different TZ= values to prove it),
// opts.utcOffset stamps local sources, and Session ids are content-derived — exporting one
// more workout must not renumber the ones already synced (§7.1 dedup).
{
  const name = "timezone-independent timestamps + stable ids";
  total++;
  const errs: string[] = [];

  const hevyCsv = read("hevy/hevy-sample.csv");
  const hevy = mapHevy(hevyCsv);
  if (hevy[0]?.startTime !== "2025-12-22T08:00:00Z") errs.push(`hevy startTime ${hevy[0]?.startTime}, want 2025-12-22T08:00:00Z regardless of host TZ`);
  if (mapHevy(hevyCsv, { utcOffset: "-08:00" })[0]?.startTime !== "2025-12-22T08:00:00-08:00") errs.push("hevy opts.utcOffset not stamped onto the wall-clock time");
  const strongCsv = read("strong/strong-sample.csv");
  const strong = mapStrong(strongCsv);
  if (strong[0]?.startTime !== "2025-12-20T18:00:00Z" || strong[0]?.endTime !== "2025-12-20T19:00:00Z")
    errs.push(`strong window ${strong[0]?.startTime}..${strong[0]?.endTime}, want 18:00Z..19:00Z regardless of host TZ`);

  if (!/^hevy-sess-[0-9a-f]{8}$/.test(hevy[0]?.id) || !hevy[0]?.clientRecordId) errs.push(`hevy id/clientRecordId not content-derived: ${hevy[0]?.id}/${hevy[0]?.clientRecordId}`);
  const [head, ...rest] = strongCsv.trim().split("\n");
  const withExtra = [head, "2025-12-19 07:00:00,Leg Day,1800,Squat (Barbell),1,100,5,0,0,,9", ...rest].join("\n");
  const renumbered = mapStrong(withExtra);
  if (renumbered.length !== 2) errs.push(`expected 2 sessions after prepending a workout, got ${renumbered.length}`);
  const moved = renumbered.find((r) => r.clientRecordId === strong[0]?.clientRecordId);
  if (!strong[0]?.clientRecordId || moved?.id !== strong[0]?.id) errs.push(`strong id not stable under re-export: ${strong[0]?.id} → ${moved?.id}`);

  if (errs.length) { fail++; console.log(`  FAIL ${name}\n${errs.map((e) => "       - " + e).join("\n")}`); }
  else console.log(`  ok   ${name} — hevy/strong instants fixed at UTC (utcOffset stamps local); ids survive a re-export with one more workout`);
}

// Strava fabrication guards: device manufacturer is never invented from device_name; HR
// summary aggregates carry derivedFrom only when the HR stream was actually fetched (no
// dangling refs); a missing time stream is a clear error, not a raw TypeError.
{
  const name = "strava fabrication guards";
  total++;
  const errs: string[] = [];

  const withHr = mapStrava(JSON.parse(read("strava/strava-sample.json")));
  const dev = withHr.find((r) => r.recordType === "Session")?.provenance?.device;
  if (dev?.manufacturer !== undefined || dev?.model !== "Garmin Forerunner 965") errs.push(`device ${JSON.stringify(dev)} — manufacturer must not be fabricated`);

  const noHrInput = JSON.parse(read("strava/strava-sample.json"));
  delete noHrInput.streams.heartrate;
  const noHr = mapStrava(noHrInput);
  const ids = new Set(noHr.map((r) => r.id));
  for (const r of noHr) for (const l of r.links ?? []) if (!ids.has(l.ref)) errs.push(`dangling ${l.type} → ${l.ref} on ${r.id}`);
  const mean = noHr.find((r) => r.type === "heart_rate_mean");
  if (!mean) errs.push("hr-mean aggregate should still be emitted without the stream (activity summary stands alone)");
  else if (mean.links !== undefined) errs.push(`hr-mean must not carry derivedFrom without an HR stream: ${JSON.stringify(mean.links)}`);
  for (const r of noHr) { const v = validate(r); if (!v.valid) errs.push(`wire ${r.recordType} ${r.id}: ${v.errors}`); }

  let msg = "";
  try { mapStrava({ activity: noHrInput.activity, streams: {} }); } catch (e: any) { msg = String(e?.message); }
  if (!msg.includes("streams.time")) errs.push(`missing time stream: expected a clear error naming streams.time, got ${JSON.stringify(msg)}`);

  if (errs.length) { fail++; console.log(`  FAIL ${name}\n${errs.map((e) => "       - " + e).join("\n")}`); }
  else console.log(`  ok   ${name} — model-only device; aggregates valid + link-free without the HR stream; missing time stream errors clearly`);
}

// Resolver wiring (OB-65): mapped Hevy/Strong exercises climb the §6.5 ladder — known
// names carry a canonical `id` PLUS the lossless original in `opaque`; unknown/curated-
// null names stay opaque-only. And crossing apps preserves names: Hevy → OpenBody →
// Strong CSV re-emits Hevy's own exercise strings byte-for-byte (to-strong.ts prefers
// `opaque`).
{
  const name = "exercise-name resolution (hevy/strong + cross-app names)";
  total++;
  const errs: string[] = [];

  const refs = (records: Record<string, any>[]) =>
    records.flatMap((s) => [...(s.exercises ?? []), ...((s.blocks ?? []).flatMap((b: any) => b.children ?? []))])
      .map((e: any) => e.exerciseRef);

  const hevyRecords = mapHevy(read("hevy/hevy-sample.csv"));
  const hevyRefs = refs(hevyRecords);
  for (const er of hevyRefs) {
    if (er.opaque === undefined) errs.push(`hevy ref ${JSON.stringify(er)} lost the original name (no opaque)`);
  }
  const expect: Record<string, string | undefined> = {
    "Leg Press (Machine)": "leg-press.machine",
    "Crunch (Weighted)": "crunch.weighted",
    "Seated Shoulder Press (Machine)": "shoulder-press.machine",
    "Pull Up (Assisted)": undefined, // curated null → opaque-only
  };
  for (const [orig, id] of Object.entries(expect)) {
    const er = hevyRefs.find((r: any) => r.opaque === orig);
    if (!er) errs.push(`hevy: no ref with opaque ${orig}`);
    else if (er.id !== id) errs.push(`hevy: ${orig} resolved to ${er.id}, expected ${id}`);
  }

  // Strong sample: "Bench Press (Barbell)" must land on the same canonical id as Hevy's.
  const strongRefs = refs(mapStrong(read("strong/strong-sample.csv")));
  const sBench = strongRefs.find((r: any) => r.opaque === "Bench Press (Barbell)");
  if (sBench?.id !== "bench-press.barbell.flat") errs.push(`strong: Bench Press (Barbell) → ${sBench?.id}`);

  // Hevy → OpenBody → Strong CSV: the emitted Exercise Name column is Hevy's original.
  const outCsv = mapOpenBodyToStrong(hevyRecords).csv;
  const outNames = new Set(parseCsv(outCsv).map((r) => r["Exercise Name"]));
  for (const orig of Object.keys(expect)) {
    if (!outNames.has(orig)) errs.push(`hevy→strong CSV dropped/renamed "${orig}" (got: ${[...outNames].join(" | ")})`);
  }

  if (errs.length) { fail++; console.log(`  FAIL ${name}\n${errs.map((e) => "       - " + e).join("\n")}`); }
  else console.log(`  ok   ${name} — ${hevyRefs.length} hevy + ${strongRefs.length} strong refs resolve; names survive Hevy→OpenBody→Strong`);
}

console.log(`\n${total - fail}/${total} mappers pass`);
if (fail) process.exit(1);
