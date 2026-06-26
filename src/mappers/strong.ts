// Strong app CSV export → OpenBody Session/Exercise/WorkUnit records.
import { num, type OpenBodyRecord, type MapOptions } from "./csv.js";

/** Map a Strong CSV export to OpenBody wire records (one Session per workout). */
export function mapStrong(csv: string, opts: MapOptions = {}): OpenBodyRecord[] {
  const subject = opts.subject ?? "subj-001";
  const text = csv.trim();
  const delim = text.split("\n")[0].includes(";") ? ";" : ",";
  const [head, ...lines] = text.split("\n");
  const cols = head.split(delim);
  const rows = lines.map((l) => Object.fromEntries(l.split(delim).map((c, i) => [cols[i], c])) as Record<string, string>);

  const byWorkout = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const k = `${r.Date}|${r["Workout Name"]}`;
    byWorkout.set(k, [...(byWorkout.get(k) ?? []), r]);
  }

  const records: OpenBodyRecord[] = [];
  let wIdx = 0;
  for (const [, wrows] of byWorkout) {
    wIdx++;
    const f = wrows[0];
    const start = new Date(f.Date.replace(" ", "T") + "Z").toISOString().replace(/\.\d{3}Z$/, "Z");
    const end = new Date(new Date(start).getTime() + Number(f.Duration || 0) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const session: OpenBodyRecord = {
      id: `strong-w${wIdx}`, recordType: "Session", subject,
      disciplines: ["strength"], startTime: start, endTime: end,
      name: f["Workout Name"],
      extension: { "io.strong.export": { workoutNo: f["Workout No"] } },
      exercises: [] as OpenBodyRecord[],
    };
    const exGroups: { name: string; sets: Record<string, string>[] }[] = [];
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
        const perf: OpenBodyRecord = {};
        if (reps) perf.reps = reps;
        if (wt) perf.load = { value: wt, unit: "kg", basis: "marked_weight" };
        if (dist) perf.distance = { absolute: { value: dist, unit: "m" } };
        if (secs) perf.time = secs;
        const wu: OpenBodyRecord = { id: `${session.id}-ex${i}-set${j}`, recordType: "WorkUnit", scoring, performance: perf };
        if (s.Notes) wu.notes = s.Notes;
        return wu;
      }),
    }));
    records.push(session);
  }
  return records;
}
