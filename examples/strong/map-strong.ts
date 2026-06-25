// Dogfooding: map a Strong app CSV export into OpenBody, validate + normalize.
// Sample is built from Strong's documented columns (Date, Workout Name, Duration,
// Exercise Name, Set Order, Weight, Reps, Distance, Seconds, Notes, Workout No);
// real exports may use ';' delimiter + unit in the Weight header (locale quirk).
// Run: tsx examples/strong/map-strong.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../src/validate.js";
import { normalizeDocument } from "../../src/normalize.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(here, "strong-sample.csv"), "utf8").trim();
const delim = text.split("\n")[0].includes(";") ? ";" : ",";
const [head, ...lines] = text.split("\n");
const cols = head.split(delim);
const rows = lines.map((l) => Object.fromEntries(l.split(delim).map((c, i) => [cols[i], c])));

const num = (s: string) => (s == null || s === "" ? undefined : Number(s));
const subject = "subj-001";

// group by workout (Date + Workout Name), then by exercise
const byWorkout = new Map<string, any[]>();
for (const r of rows) byWorkout.set(`${r.Date}|${r["Workout Name"]}`, [...(byWorkout.get(`${r.Date}|${r["Workout Name"]}`) ?? []), r]);

const records: any[] = [];
let wIdx = 0;
for (const [, wrows] of byWorkout) {
  wIdx++;
  const f = wrows[0];
  const start = new Date(f.Date.replace(" ", "T") + "Z").toISOString().replace(/\.\d{3}Z$/, "Z");
  const end = new Date(new Date(start).getTime() + Number(f.Duration || 0) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const session: any = {
    id: `strong-w${wIdx}`, recordType: "Session", subject,
    disciplines: ["strength"], startTime: start, endTime: end,
    name: f["Workout Name"], // RESOLVED (v0.3): first-class `name`.
    // workoutNo is a vendor record id (not a user-facing label) -> stays in extension.
    extension: { "io.strong.export": { workoutNo: f["Workout No"] } },
    exercises: [] as any[],
  };
  const exGroups: { name: string; sets: any[] }[] = [];
  for (const r of wrows) {
    const last = exGroups[exGroups.length - 1];
    if (last && last.name === r["Exercise Name"]) last.sets.push(r);
    else exGroups.push({ name: r["Exercise Name"], sets: [r] });
  }
  session.exercises = exGroups.map((g, i) => ({
    id: `${session.id}-ex${i}`, recordType: "Exercise", exerciseRef: { opaque: g.name },
    workUnits: g.sets.map((s, j) => {
      const reps = num(s.Reps), dist = num(s.Distance), secs = num(s.Seconds), wt = num(s.Weight);
      const scoring = reps ? "reps" : dist ? "distance" : secs ? "time" : "reps";
      const perf: any = {};
      if (reps) perf.reps = reps;
      if (wt) perf.load = { value: wt, unit: "kg", basis: "marked_weight" };
      if (dist) perf.distance = { absolute: { value: dist, unit: "m" } };
      if (secs) perf.time = secs;
      const wu: any = { id: `${session.id}-ex${i}-set${j}`, recordType: "WorkUnit", scoring, performance: perf };
      if (s.Notes) wu.notes = s.Notes; // RESOLVED (v0.3): first-class `notes`.
      return wu;
    }),
  }));
  records.push(session);
}

console.log(`Mapped ${rows.length} Strong set-rows -> ${records.length} OpenBody Session(s).\n`);
console.log("Session (wire):\n" + JSON.stringify(records[0], null, 2) + "\n");
let bad = 0;
for (const r of records) { const v = validate(r); if (!v.valid) { bad++; console.log(`  FAIL ${r.id}: ${v.errors}`); } }
console.log(bad ? `${bad} invalid` : `All ${records.length} wire record(s) validate. ✅`);
console.log(`Normalized to ${normalizeDocument(records).length} flat canonical records.`);
