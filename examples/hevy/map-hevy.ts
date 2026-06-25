// Dogfooding: map a REAL Hevy CSV export into OpenBody, then validate + normalize it.
// Also a seed for the eventual Hevy mapper (Phase D). Run: tsx examples/hevy/map-hevy.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../src/validate.js";
import { normalizeDocument } from "../../src/normalize.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const csv = fs.readFileSync(path.join(here, "hevy-sample.csv"), "utf8");

// minimal quoted-CSV parser
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (cell !== "" || row.length) { row.push(cell); rows.push(row); row = []; cell = ""; } if (c === "\r" && text[i + 1] === "\n") i++; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift()!;
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// "22 Dec 2025, 08:00" -> RFC 3339 (assume UTC; real export carries local time)
function toRfc3339(s: string): string {
  const d = new Date(s.replace(",", ""));
  return isNaN(d.getTime()) ? s : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
const SET_ROLE: Record<string, string> = { normal: "working", warmup: "warmup", drop: "drop", failure: "failure" };
const num = (s: string) => (s === "" || s == null ? undefined : Number(s));

const rows = parseCsv(csv);

// group rows into sessions by (title + start_time)
const sessions = new Map<string, Record<string, string>[]>();
for (const r of rows) sessions.set(`${r.title}|${r.start_time}`, [...(sessions.get(`${r.title}|${r.start_time}`) ?? []), r]);

const records: any[] = [];
let sIdx = 0;
for (const [, srows] of sessions) {
  sIdx++;
  const f = srows[0];
  const hasSuperset = srows.some((r) => r.superset_id !== "");
  const session: any = {
    id: `hevy-sess-${sIdx}`, recordType: "Session", subject: "subj-001",
    disciplines: ["strength"], startTime: toRfc3339(f.start_time), endTime: toRfc3339(f.end_time),
  };
  // group consecutive rows by exercise (title + superset_id)
  const exGroups: { title: string; superset: string; sets: Record<string, string>[] }[] = [];
  for (const r of srows) {
    const last = exGroups[exGroups.length - 1];
    if (last && last.title === r.exercise_title && last.superset === r.superset_id) last.sets.push(r);
    else exGroups.push({ title: r.exercise_title, superset: r.superset_id, sets: [r] });
  }
  const makeExercise = (g: typeof exGroups[number], idx: number) => {
    const assisted = /assisted/i.test(g.title);
    const workUnits = g.sets.map((s, j) => {
      const wu: any = { id: `${session.id}-ex${idx}-set${j}`, recordType: "WorkUnit",
        scoring: num(s.reps) != null ? "reps" : num(s.distance_km) != null ? "distance" : "time",
        setRole: SET_ROLE[s.set_type] ?? s.set_type };
      const perf: any = {};
      if (num(s.reps) != null) perf.reps = num(s.reps);
      if (num(s.weight_kg)) perf.load = { value: num(s.weight_kg), unit: "kg", basis: assisted ? "assist" : "marked_weight" };
      if (num(s.distance_km)) perf.distance = { absolute: { value: num(s.distance_km), unit: "km" } };
      if (num(s.duration_seconds)) perf.time = num(s.duration_seconds);
      if (num(s.rpe) != null) perf.effortLoad = [{ kind: "internal", method: "RPE", value: num(s.rpe) }];
      wu.performance = perf;
      return wu;
    });
    return { id: `${session.id}-ex${idx}`, recordType: "Exercise", exerciseRef: { opaque: g.title }, workUnits };
  };
  if (hasSuperset) {
    // OpenBody §5.3: at-most-one container -> when any superset exists, everything goes under blocks[].
    const blocks: any[] = []; const used = new Set<number>();
    exGroups.forEach((g, i) => {
      if (used.has(i)) return;
      if (g.superset === "") { blocks.push({ id: `${session.id}-blk${i}`, recordType: "Block", children: [makeExercise(g, i)] }); }
      else {
        const mates = exGroups.map((gg, k) => ({ gg, k })).filter(({ gg }) => gg.superset === g.superset);
        mates.forEach(({ k }) => used.add(k));
        blocks.push({ id: `${session.id}-ss${g.superset}`, recordType: "Block", grouping: "superset", children: mates.map(({ gg, k }) => makeExercise(gg, k)) });
      }
    });
    session.blocks = blocks;
  } else {
    session.exercises = exGroups.map(makeExercise);
  }
  records.push(session);
}

// ---- dogfood ----
console.log(`Mapped ${rows.length} Hevy set-rows -> ${records.length} OpenBody Session record(s).\n`);
console.log("Session JSON (wire form):\n" + JSON.stringify(records[0], null, 2) + "\n");

// 1. Validate the WIRE records (the nested document the producer emits) against the schema.
//    NOTE: validate wire records, NOT the §8.3 canonical form (which uses string fixed-point
//    and propagated fields — an internal comparison representation, not the wire binding).
let bad = 0;
for (const rec of records) {
  const v = validate(rec);
  if (!v.valid) { bad++; console.log(`  FAIL wire ${rec.recordType} ${rec.id}: ${v.errors}`); }
}
console.log(bad ? `${bad} wire record(s) invalid` : `All ${records.length} wire record(s) validate against the schema. ✅`);

// 2. Normalize (for equivalence/round-trip) and show the canonical flat form.
const canonical = normalizeDocument(records);
console.log(`\nNormalized to ${canonical.length} flat canonical records (string fixed-point; comparison form):`);
for (const s of canonical) console.log("  " + s);
