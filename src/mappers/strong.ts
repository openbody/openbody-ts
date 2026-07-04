// Strong app CSV export → OpenBody Session/Exercise/WorkUnit records.

import { resolveExerciseRef } from "../resolve.js";
import type {
  Exercise,
  LiveRecord,
  MapOptions,
  MapperResult,
  MapWarning,
  Performance,
  Session,
  WorkUnit,
} from "../types.js";
import { addSeconds, contentHash, num, parseCsvDoc, requireColumns, toRfc3339 } from "./csv.js";
import { subjectFor } from "./shared.js";

/**
 * Map a Strong CSV export to OpenBody wire records: one Session per workout (grouped
 * by `Date`+`Workout Name`), sets grouped into Exercises by `Exercise Name`. The
 * column delimiter (`,` or `;`) is sniffed from the header row.
 *
 * Input precondition: the CSV's header row must carry `Date`, `Workout Name`, and
 * `Exercise Name` — anything else throws `MapperInputError` (`mapper: "strong"`).
 *
 * `opts.utcOffset` stamps Strong's offset-less `"2026-03-02 06:45:00"`-style
 * timestamps (default `"Z"`).
 *
 * Warnings this mapper can emit: `default-subject` (no `opts.subject` given),
 * `unparseable-date` (a row's `Date` cell is blank/garbled, so `endTime` is omitted).
 */
export function mapStrong(csv: string, opts: MapOptions = {}): MapperResult {
  const warnings: MapWarning[] = [];
  const subject = subjectFor(opts, warnings, "strong");
  const off = opts.utcOffset ?? "Z";
  // Delimiter sniffed from the header (Strong exports "," or ";" by locale); the shared
  // quoted-CSV parser handles commas/newlines inside quoted workout names and notes.
  const delim = (csv.trimStart().split("\n")[0] ?? "").includes(";") ? ";" : ",";
  const { header, rows } = parseCsvDoc(csv, delim);
  // Structural minimum (WP7): the columns the session key + set mapping hang off.
  requireColumns("strong", header, ["Date", "Workout Name", "Exercise Name"]);

  const byWorkout = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const k = `${r.Date}|${r["Workout Name"]}`;
    byWorkout.set(k, [...(byWorkout.get(k) ?? []), r]);
  }

  const records: LiveRecord[] = [];
  for (const [key, wrows] of byWorkout) {
    const f = wrows[0];
    if (f === undefined) continue; // unreachable: groups are created non-empty
    const start = toRfc3339(f.Date ?? "", off);
    // start + Duration = end (see csv.addSeconds); undefined when the Date cell is blank/
    // unparseable — degrade by omitting endTime + warning (never throw, src/errors.ts).
    const end = addSeconds(start, Number(f.Duration || 0), off);
    if (end === undefined)
      warnings.push({
        code: "unparseable-date",
        message: `workout "${key}" has a blank or unparseable Date ("${f.Date ?? ""}") — endTime omitted`,
        context: { mapper: "strong", clientRecordId: key, date: f.Date ?? "" },
      });
    const session: Session = {
      // The export has no workout id of its own, so the natural key (Date|Workout Name) is
      // the client identifier (§7.1) and a hash of it the stable id — positional numbering
      // would renumber everything when one more workout is exported, defeating dedup.
      id: `strong-w-${contentHash(key)}`,
      recordType: "Session",
      subject,
      clientRecordId: key,
      disciplines: ["strength"],
      startTime: start,
      ...(end !== undefined ? { endTime: end } : {}),
      name: f["Workout Name"],
      extension: { "io.strong.export": { workoutNo: f["Workout No"] } },
      exercises: [] as Exercise[],
    };
    const exGroups: { name: string | undefined; sets: Record<string, string>[] }[] = [];
    for (const r of wrows) {
      const last = exGroups[exGroups.length - 1];
      if (last && last.name === r["Exercise Name"]) last.sets.push(r);
      else exGroups.push({ name: r["Exercise Name"], sets: [r] });
    }
    session.exercises = exGroups.map((g, i) => ({
      // §6.5 ladder via the registry crosswalk: canonical id where one resolves, with the
      // original Strong name preserved losslessly in `opaque` (see src/resolve.ts).
      id: `${session.id}-ex${i}`,
      recordType: "Exercise",
      exerciseRef: resolveExerciseRef(g.name ?? "", { source: "strong" }),
      workUnits: g.sets.map((s, j) => {
        const reps = num(s.Reps),
          dist = num(s.Distance),
          secs = num(s.Seconds),
          wt = num(s.Weight);
        const scoring = reps ? "reps" : dist ? "distance" : secs ? "time" : "reps";
        const perf: Performance = {};
        if (reps) perf.reps = reps;
        if (wt) perf.load = { value: wt, unit: "kg", basis: "marked_weight" };
        if (dist) perf.distance = { absolute: { value: dist, unit: "m" } };
        if (secs) perf.time = secs;
        const wu: WorkUnit = {
          id: `${session.id}-ex${i}-set${j}`,
          recordType: "WorkUnit",
          scoring,
          performance: perf,
        };
        if (s.Notes) wu.notes = s.Notes;
        return wu;
      }),
    }));
    records.push(session);
  }
  return { records, warnings };
}
