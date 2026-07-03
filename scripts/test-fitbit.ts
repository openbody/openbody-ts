// Fitbit (Google Takeout) mapper tests — self-contained (OB-80). Same ok/FAIL style as
// test-mappers.ts. Covers: every wire record schema-validates + normalization round-trips,
// sleep stages are ADJACENT category Measurements (incl. the shortData wake spliced into
// the deep segment), weight is exact fixed-point in [lb_av], discipline mapping + the
// fitbit:<name> fallback, intraday steps/HR collapse to one sampleArray per day, and
// unknown/empty/corrupt files are ignored gracefully.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/schema-loader-node.js";
import { normalizeDocument } from "../src/normalize.js";
import { mapFitbitTakeout } from "../src/mappers/fitbit.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples/fitbit");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), "utf8") }));

let fail = 0, total = 0;
const check = (name: string, errs: string[], okMsg: string) => {
  total++;
  if (errs.length) { fail++; console.log(`  FAIL ${name}\n${errs.map((e) => "       - " + e).join("\n")}`); }
  else console.log(`  ok   ${name} — ${okMsg}`);
};

const records = mapFitbitTakeout(files, { utcOffset: "-08:00" });

// 1. Every wire record validates; normalization is idempotent (§8.3 round-trip).
{
  const errs: string[] = [];
  if (records.length === 0) errs.push("mapped 0 records");
  for (const r of records) {
    const v = validate(r);
    if (!v.valid) errs.push(`wire ${r.recordType} ${r.id}: ${v.errors}`);
  }
  const n1 = normalizeDocument(records);
  const n2 = normalizeDocument(n1.map((s) => JSON.parse(s)));
  if (!(n1.length === n2.length && n1.every((s, i) => s === n2[i]))) errs.push("normalization not idempotent (round-trip)");
  check("schema + round-trip", errs, `${records.length} wire records validate; ${n1.length} canonical (round-trip stable)`);
}

// 2. Sleep: category Measurements over ADJACENT intervals (§4.3), with the 2-min shortData
// wake spliced into the deep segment (5 data segments → 7: deep is split around the wake).
{
  const errs: string[] = [];
  const stages = records.filter((r) => r.type === "sleep_stage")
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  if (stages.length !== 7) errs.push(`expected 7 stage intervals (5 data + deep split by 1 short wake), got ${stages.length}`);
  for (let i = 0; i < stages.length - 1; i++)
    if (stages[i]?.endTime !== stages[i + 1]?.startTime) errs.push(`gap/overlap: ${stages[i]?.id} ends ${stages[i]?.endTime}, ${stages[i + 1]?.id} starts ${stages[i + 1]?.startTime}`);
  const seq = stages.map((s) => s.category).join(",");
  if (seq !== "awake,light,deep,awake,deep,rem,light") errs.push(`stage sequence: ${seq}`);
  for (const s of stages) {
    if (s.category !== undefined && s.quantity !== undefined) errs.push(`${s.id} has both category and quantity`);
    if (s.unit !== undefined) errs.push(`${s.id}: category Measurement must not carry a unit`);
  }
  // Fitbit's own summary → registry sleep tokens as interval quantities over the log window.
  for (const [type, mins] of [["sleep_duration", 168], ["sleep_deep", 58], ["sleep_light", 80], ["sleep_rem", 30], ["sleep_awake", 8]] as const) {
    const r = records.find((x) => x.type === type);
    if (!r) errs.push(`missing ${type}`);
    else if (r.quantity !== mins || r.unit !== "min") errs.push(`${type}: ${r.quantity} ${r.unit}, want ${mins} min`);
    else if (r.startTime !== "2024-01-05T23:04:00-08:00" || r.endTime !== "2024-01-06T02:00:00-08:00") errs.push(`${type} window: ${r.startTime}..${r.endTime}`);
  }
  check("sleep stages + summary", errs, `${stages.length} adjacent stage intervals (short wake spliced) + 5 summary quantities`);
}

// 3. Weight: exact §4.2 fixed-point in [lb_av] (175.5 → 1755e-1; integer 175 → 175e0),
// Aria scale → sensor+device, API entry → manual; bmi + fat ride along.
{
  const errs: string[] = [];
  const w = records.filter((r) => r.type === "body_mass");
  if (w.length !== 2) errs.push(`expected 2 body_mass records, got ${w.length}`);
  const aria = w.find((r) => r.id === "fitbit-weight-1704526260000");
  if (JSON.stringify(aria?.quantity) !== JSON.stringify({ coefficient: 1755, exponent: -1 })) errs.push(`175.5 lb fixed-point: ${JSON.stringify(aria?.quantity)}`);
  if (aria?.unit !== "[lb_av]") errs.push(`unit: ${aria?.unit}`);
  if (aria?.provenance?.method !== "sensor" || aria?.provenance?.device?.model !== "Aria") errs.push(`Aria provenance: ${JSON.stringify(aria?.provenance)}`);
  if (aria?.clientRecordId !== "1704526260000") errs.push(`clientRecordId: ${aria?.clientRecordId}`);
  const manual = w.find((r) => r.id === "fitbit-weight-1704612600000");
  if (JSON.stringify(manual?.quantity) !== JSON.stringify({ coefficient: 175, exponent: 0 })) errs.push(`175 lb fixed-point: ${JSON.stringify(manual?.quantity)}`);
  if (manual?.provenance?.method !== "manual") errs.push(`API-entry method: ${manual?.provenance?.method}`);
  const fat = records.find((r) => r.type === "body_fat_percentage");
  if (JSON.stringify(fat?.quantity) !== JSON.stringify({ coefficient: 215, exponent: -1 })) errs.push(`fat fixed-point: ${JSON.stringify(fat?.quantity)}`);
  if (records.filter((r) => r.type === "bmi").length !== 2) errs.push("expected 2 bmi records");
  check("weight fixed-point", errs, "2 weigh-ins exact in [lb_av] (+bmi/fat), Aria→sensor, API→manual");
}

// 4. Sessions: activityName → canonical discipline; unknown name → fitbit:<name> fallback;
// summary aggregates hang off the WorkUnit via measuredBy.
{
  const errs: string[] = [];
  const run = records.find((r) => r.id === "fitbit-ex-21092332392");
  if (!run) errs.push("missing Run session");
  else {
    if (JSON.stringify(run.disciplines) !== '["running"]') errs.push(`Run disciplines: ${JSON.stringify(run.disciplines)}`);
    if (run.clientRecordId !== "21092332392") errs.push(`clientRecordId: ${run.clientRecordId}`);
    if (run.startTime !== "2024-01-06T07:08:57-08:00" || run.endTime !== "2024-01-06T07:39:40-08:00") errs.push(`window: ${run.startTime}..${run.endTime}`);
    const perf = run.workUnits?.[0]?.performance;
    if (perf?.time?.absolute?.value !== 1843) errs.push(`time: ${JSON.stringify(perf?.time)}`);
    if (perf?.distance?.absolute?.value !== 5.28 || perf?.distance?.absolute?.unit !== "km") errs.push(`distance: ${JSON.stringify(perf?.distance)}`);
    if (perf?.energy?.absolute?.value !== 306) errs.push(`energy: ${JSON.stringify(perf?.energy)}`);
    const refs = (run.workUnits?.[0]?.links ?? []).filter((l: any) => l.type === "measuredBy").map((l: any) => l.ref);
    for (const ref of ["fitbit-ex-21092332392-hr-mean", "fitbit-ex-21092332392-steps"])
      if (!refs.includes(ref) || !records.find((r) => r.id === ref)) errs.push(`missing measuredBy aggregate ${ref}`);
    if (!run.extension?.fitbit?.heartRateZones) errs.push("heartRateZones not preserved in extension");
  }
  const ell = records.find((r) => r.id === "fitbit-ex-21092332999");
  if (JSON.stringify(ell?.disciplines) !== '["fitbit:elliptical"]') errs.push(`fallback disciplines: ${JSON.stringify(ell?.disciplines)}`);
  if (ell?.provenance?.method !== "manual") errs.push(`manual log method: ${ell?.provenance?.method}`);
  if (ell?.workUnits?.[0]?.links !== undefined) errs.push("Elliptical (no aggregates) should have no links");
  check("sessions + disciplines", errs, "Run→running w/ perf + 2 measuredBy aggregates; Elliptical→fitbit:elliptical, manual");
}

// 5. Intraday volume: one sampleArray per day per stream, offsets from timestamps.
{
  const errs: string[] = [];
  const hr = records.filter((r) => r.type === "heart_rate" && r.sampleArray);
  if (hr.length !== 1) errs.push(`expected 1 HR day-series, got ${hr.length}`);
  else {
    const sa = hr[0]?.sampleArray;
    if (sa.offsets.length !== 10 || sa.dataPoints.length !== 10) errs.push(`HR lengths: ${sa.offsets.length}/${sa.dataPoints.length}`);
    if (sa.offsets[0] !== 0 || sa.offsets[9] !== 105) errs.push(`HR offsets: ${sa.offsets[0]}..${sa.offsets[9]} (want 0..105)`);
    if (hr[0]?.unit !== "/min" || sa.dataPoints[0] !== 76) errs.push(`HR series: unit=${hr[0]?.unit}, first=${sa.dataPoints[0]}`);
    if (!hr[0]?.startTime.endsWith("Z")) errs.push(`HR timestamps are documented UTC; startTime=${hr[0]?.startTime}`);
    if (hr[0]?.endTime !== "2024-01-06T07:01:46Z") errs.push(`HR endTime: ${hr[0]?.endTime}`);
  }
  const st = records.filter((r) => r.type === "step_count" && r.sampleArray);
  if (st.length !== 1) errs.push(`expected 1 steps day-series, got ${st.length}`);
  else {
    const sa = st[0]?.sampleArray;
    if (sa.dataPoints.length !== 8 || sa.dataPoints[2] !== 64) errs.push(`steps dataPoints: ${JSON.stringify(sa.dataPoints)}`);
    if (sa.offsets[7] !== 660) errs.push(`steps last offset: ${sa.offsets[7]} (want 660 — 11 min, incl. the bucket gap)`);
    if (!st[0]?.startTime.endsWith("-08:00")) errs.push(`steps are local time; startTime=${st[0]?.startTime}`);
  }
  const rhr = records.filter((r) => r.type === "resting_heart_rate");
  if (rhr.length !== 1) errs.push(`zero-value RHR day must be skipped: got ${rhr.length}`);
  else if (rhr[0]?.startTime !== "2024-01-06T00:00:00-08:00" || rhr[0]?.endTime !== "2024-01-07T00:00:00-08:00") errs.push(`RHR window: ${rhr[0]?.startTime}..${rhr[0]?.endTime}`);
  check("intraday series + RHR", errs, "1 HR + 1 steps sampleArray per day (HR in UTC, steps local); RHR daily interval, zero-day skipped");
}

// 6. Robustness: unknown names, corrupt JSON, non-array JSON, empty input → no throw, no records.
{
  const errs: string[] = [];
  const junk = mapFitbitTakeout([
    { name: "sessions.csv", text: "a,b\n1,2" },
    { name: "exercise-1.json", text: "{ not json" },
    { name: "steps-2024-01-01.json", text: '{"not":"an array"}' },
    { name: "heart_rate-2024-01-02.json", text: "[]" },
    { name: "Takeout/Fitbit/Global Export Data/weight-2024-02-01.json", text: "[]" },
  ]);
  if (junk.length !== 0) errs.push(`junk input produced ${junk.length} records`);
  if (mapFitbitTakeout([]).length !== 0) errs.push("empty input produced records");
  // path-prefixed names still classify by basename:
  const nested = mapFitbitTakeout([{ name: "Takeout/Fitbit/Global Export Data/weight-2024-01-01.json", text: files.find((f) => f.name === "weight-2024-01-01.json")!.text }]);
  if (nested.filter((r) => r.type === "body_mass").length !== 2) errs.push("basename classification failed for nested path");
  check("robustness", errs, "unknown/corrupt/non-array/empty files ignored; nested Takeout paths classify by basename");
}

console.log(`\n${total - fail}/${total} fitbit checks pass`);
if (fail) process.exit(1);
