// Hevy CSV export → OpenBody Session/Block/Exercise/WorkUnit records.

import { resolveExerciseRef } from "../resolve.js";
import type {
  Block,
  Exercise,
  LiveRecord,
  MapOptions,
  MapperResult,
  MapWarning,
  Performance,
  Session,
  WorkUnit,
} from "../types.js";
import { contentHash, num, parseCsvDoc, requireColumns, toRfc3339 } from "./csv.js";
import { subjectFor } from "./shared.js";

const SET_ROLE: Record<string, string> = { normal: "working", warmup: "warmup", drop: "drop", failure: "failure" };

/**
 * Map a Hevy CSV export to OpenBody wire records: one Session per workout (grouped by
 * `title`+`start_time`), sets grouped into Exercise/Block by exercise + superset id.
 *
 * Input precondition: the CSV's header row must carry `title`, `start_time`, and
 * `exercise_title` — anything else throws `MapperInputError` (`mapper: "hevy"`).
 *
 * `opts.utcOffset` stamps Hevy's offset-less `"22 Dec 2025, 08:00"`-style timestamps
 * (default `"Z"`).
 *
 * Warnings this mapper can emit: `default-subject` (no `opts.subject` given).
 */
export function mapHevy(csv: string, opts: MapOptions = {}): MapperResult {
  const warnings: MapWarning[] = [];
  const subject = subjectFor(opts, warnings, "hevy");
  const { header, rows } = parseCsvDoc(csv);
  // Structural minimum (WP7): the session key + exercise grouping columns.
  requireColumns("hevy", header, ["title", "start_time", "exercise_title"]);

  const sessions = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const k = `${r.title}|${r.start_time}`;
    sessions.set(k, [...(sessions.get(k) ?? []), r]);
  }

  const records: LiveRecord[] = [];
  for (const [key, srows] of sessions) {
    const f = srows[0];
    if (f === undefined) continue; // unreachable: groups are created non-empty
    const hasSuperset = srows.some((r) => r.superset_id !== "");
    const session: Session = {
      // The export has no workout id of its own, so the natural key (title|start_time) is
      // the client identifier (§7.1) and a hash of it the stable id — positional numbering
      // would renumber everything when one more workout is exported, defeating dedup.
      id: `hevy-sess-${contentHash(key)}`,
      recordType: "Session",
      subject,
      clientRecordId: key,
      name: f.title,
      ...(f.description ? { notes: f.description } : {}),
      disciplines: ["strength"],
      startTime: toRfc3339(f.start_time ?? "", opts.utcOffset),
      endTime: toRfc3339(f.end_time ?? "", opts.utcOffset),
    };
    const exGroups: { title: string | undefined; superset: string | undefined; sets: Record<string, string>[] }[] = [];
    for (const r of srows) {
      const last = exGroups[exGroups.length - 1];
      if (last && last.title === r.exercise_title && last.superset === r.superset_id) last.sets.push(r);
      else exGroups.push({ title: r.exercise_title, superset: r.superset_id, sets: [r] });
    }
    const makeExercise = (g: (typeof exGroups)[number], idx: number): Exercise => {
      const title = g.title ?? "";
      const assisted = /assisted/i.test(title);
      const workUnits = g.sets.map((s, j) => {
        // Hoisted so the truthy/null guards below narrow (num is pure — same values as before).
        const reps = num(s.reps),
          weight = num(s.weight_kg),
          dist = num(s.distance_km),
          secs = num(s.duration_seconds),
          rpe = num(s.rpe);
        const wu: WorkUnit = {
          id: `${session.id}-ex${idx}-set${j}`,
          recordType: "WorkUnit",
          scoring: reps != null ? "reps" : dist != null ? "distance" : "time",
          setRole: SET_ROLE[s.set_type ?? ""] ?? s.set_type,
        };
        const perf: Performance = {};
        if (reps != null) perf.reps = reps;
        if (weight) perf.load = { value: weight, unit: "kg", basis: assisted ? "assist" : "marked_weight" };
        if (dist) perf.distance = { absolute: { value: dist, unit: "km" } };
        if (secs) perf.time = secs;
        if (rpe != null) perf.effortLoad = [{ kind: "internal", method: "RPE", value: rpe }];
        wu.performance = perf;
        return wu;
      });
      // §6.5 ladder via the registry crosswalk: canonical id where one resolves, with the
      // original Hevy name preserved losslessly in `opaque` (see src/resolve.ts).
      return {
        id: `${session.id}-ex${idx}`,
        recordType: "Exercise",
        exerciseRef: resolveExerciseRef(title, { source: "hevy" }),
        workUnits,
      };
    };
    if (hasSuperset) {
      // §5.3 at-most-one container: any superset ⇒ everything goes under blocks[].
      const blocks: Block[] = [];
      const used = new Set<number>();
      exGroups.forEach((g, i) => {
        if (used.has(i)) return;
        if (g.superset === "")
          blocks.push({ id: `${session.id}-blk${i}`, recordType: "Block", children: [makeExercise(g, i)] });
        else {
          const mates = exGroups.map((gg, k) => ({ gg, k })).filter(({ gg }) => gg.superset === g.superset);
          mates.forEach(({ k }) => {
            used.add(k);
          });
          blocks.push({
            id: `${session.id}-ss${g.superset}`,
            recordType: "Block",
            grouping: "superset",
            children: mates.map(({ gg, k }) => makeExercise(gg, k)),
          });
        }
      });
      session.blocks = blocks;
    } else {
      session.exercises = exGroups.map(makeExercise);
    }
    records.push(session);
  }
  return { records, warnings };
}
