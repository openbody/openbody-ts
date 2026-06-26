// Hevy CSV export → OpenBody Session/Block/Exercise/WorkUnit records.
import { parseCsv, num, toRfc3339, type OpenBodyRecord, type MapOptions } from "./csv.js";

const SET_ROLE: Record<string, string> = { normal: "working", warmup: "warmup", drop: "drop", failure: "failure" };

/** Map a Hevy CSV export to OpenBody wire records (one Session per workout). */
export function mapHevy(csv: string, opts: MapOptions = {}): OpenBodyRecord[] {
  const subject = opts.subject ?? "subj-001";
  const rows = parseCsv(csv);

  const sessions = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const k = `${r.title}|${r.start_time}`;
    sessions.set(k, [...(sessions.get(k) ?? []), r]);
  }

  const records: OpenBodyRecord[] = [];
  let sIdx = 0;
  for (const [, srows] of sessions) {
    sIdx++;
    const f = srows[0];
    const hasSuperset = srows.some((r) => r.superset_id !== "");
    const session: OpenBodyRecord = {
      id: `hevy-sess-${sIdx}`, recordType: "Session", subject,
      name: f.title,
      ...(f.description ? { notes: f.description } : {}),
      disciplines: ["strength"], startTime: toRfc3339(f.start_time), endTime: toRfc3339(f.end_time),
    };
    const exGroups: { title: string; superset: string; sets: Record<string, string>[] }[] = [];
    for (const r of srows) {
      const last = exGroups[exGroups.length - 1];
      if (last && last.title === r.exercise_title && last.superset === r.superset_id) last.sets.push(r);
      else exGroups.push({ title: r.exercise_title, superset: r.superset_id, sets: [r] });
    }
    const makeExercise = (g: typeof exGroups[number], idx: number) => {
      const assisted = /assisted/i.test(g.title);
      const workUnits = g.sets.map((s, j) => {
        const wu: OpenBodyRecord = {
          id: `${session.id}-ex${idx}-set${j}`, recordType: "WorkUnit",
          scoring: num(s.reps) != null ? "reps" : num(s.distance_km) != null ? "distance" : "time",
          setRole: SET_ROLE[s.set_type] ?? s.set_type,
        };
        const perf: OpenBodyRecord = {};
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
      // §5.3 at-most-one container: any superset ⇒ everything goes under blocks[].
      const blocks: OpenBodyRecord[] = []; const used = new Set<number>();
      exGroups.forEach((g, i) => {
        if (used.has(i)) return;
        if (g.superset === "") blocks.push({ id: `${session.id}-blk${i}`, recordType: "Block", children: [makeExercise(g, i)] });
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
  return records;
}
