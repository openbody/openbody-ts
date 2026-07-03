// Strong app CSV export → OpenBody Session/Exercise/WorkUnit records.
import { parseCsv, num, toRfc3339, contentHash } from "./csv.js";
import type { OpenBodyRecord, MapOptions } from "../types.js";
import { resolveExerciseRef } from "../resolve.js";

/** Map a Strong CSV export to OpenBody wire records (one Session per workout). */
export function mapStrong(csv: string, opts: MapOptions = {}): OpenBodyRecord[] {
  const subject = opts.subject ?? "subj-001";
  const off = opts.utcOffset ?? "Z";
  // Delimiter sniffed from the header (Strong exports "," or ";" by locale); the shared
  // quoted-CSV parser handles commas/newlines inside quoted workout names and notes.
  const delim = (csv.trimStart().split("\n")[0] ?? "").includes(";") ? ";" : ",";
  const rows = parseCsv(csv, delim);

  const byWorkout = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const k = `${r.Date}|${r["Workout Name"]}`;
    byWorkout.set(k, [...(byWorkout.get(k) ?? []), r]);
  }

  const records: OpenBodyRecord[] = [];
  for (const [key, wrows] of byWorkout) {
    const f = wrows[0];
    if (f === undefined) continue; // unreachable: groups are created non-empty
    const start = toRfc3339(f.Date ?? "", off);
    // Wall-clock + Duration arithmetic on a fixed UTC anchor (a constant offset cancels in
    // the difference, fitbit.ts precedent), so the end carries the same offset as the start.
    const wall = start.replace(/(?:Z|[+-]\d\d:\d\d)$/, "");
    const end = new Date(Date.parse(wall + "Z") + Number(f.Duration || 0) * 1000).toISOString().slice(0, 19) + off;
    const session: OpenBodyRecord = {
      // The export has no workout id of its own, so the natural key (Date|Workout Name) is
      // the client identifier (§7.1) and a hash of it the stable id — positional numbering
      // would renumber everything when one more workout is exported, defeating dedup.
      id: `strong-w-${contentHash(key)}`,
      recordType: "Session",
      subject,
      clientRecordId: key,
      disciplines: ["strength"],
      startTime: start,
      endTime: end,
      name: f["Workout Name"],
      extension: { "io.strong.export": { workoutNo: f["Workout No"] } },
      exercises: [] as OpenBodyRecord[],
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
        const perf: OpenBodyRecord = {};
        if (reps) perf.reps = reps;
        if (wt) perf.load = { value: wt, unit: "kg", basis: "marked_weight" };
        if (dist) perf.distance = { absolute: { value: dist, unit: "m" } };
        if (secs) perf.time = secs;
        const wu: OpenBodyRecord = {
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
  return records;
}
