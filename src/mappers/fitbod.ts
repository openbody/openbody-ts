// Fitbod app CSV export → OpenBody Session/Exercise/WorkUnit records.

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

// Fitbod's export is one row per SET, columns (v1 layout, per the public OSS parsers):
//   Date, Exercise, Reps, Weight(kg), Duration(s), Distance(m), Incline, Resistance,
//   isWarmup, Note, multiplier
// Unlike Strong it has NO workout name/id column, so sessions are inferred from the
// per-set timestamps: consecutive sets more than SESSION_GAP_S apart start a new Session
// (handles two-a-days without merging a whole day). Fitbod-specific per-set fields with no
// core home (incline/resistance/multiplier/warmup) round-trip losslessly in a namespaced
// `extension` (§8.1) rather than being dropped.
//
// NOTE: the bundled fixture (`examples/fitbod/`) is SYNTHETIC — hand-authored to the
// documented column layout, not a real Fitbod export. Timestamp format (offset-less vs
// tz-suffixed) and multiplier semantics for bodyweight moves want confirming against a
// real export (OB-82).

const SESSION_GAP_S = 3 * 60 * 60; // 3h between sets ⇒ a new session

const isTrue = (v: string | undefined) => /^(true|1|yes)$/i.test((v ?? "").trim());

/**
 * Map a Fitbod CSV export to OpenBody wire records: one Session per workout (inferred by
 * a >3h gap between set timestamps), sets grouped into Exercises by run of `Exercise`.
 *
 * Input precondition: the header must carry `Date`, `Exercise`, `Reps`, `Weight(kg)` —
 * else `MapperInputError` (`mapper: "fitbod"`).
 *
 * `opts.utcOffset` stamps Fitbod's offset-less `"2026-01-15 08:00:00"`-style timestamps
 * (default `"Z"`).
 *
 * Warnings: `default-subject` (no `opts.subject`), `unparseable-date` (a session's first
 * `Date` cell is blank/garbled, so `startTime`/`endTime` are omitted).
 */
export function mapFitbod(csv: string, opts: MapOptions = {}): MapperResult {
  const warnings: MapWarning[] = [];
  const subject = subjectFor(opts, warnings, "fitbod");
  const off = opts.utcOffset ?? "Z";
  const delim = (csv.trimStart().split("\n")[0] ?? "").includes(";") ? ";" : ",";
  const { header, rows } = parseCsvDoc(csv, delim);
  requireColumns("fitbod", header, ["Date", "Exercise", "Reps", "Weight(kg)"]);

  // Chronological order is the basis for the gap-split; Fitbod may export newest- or
  // oldest-first. Sort by the raw `Date` string (ISO-ish, so lexical == chronological).
  const sorted = [...rows].sort((a, b) => (a.Date ?? "").localeCompare(b.Date ?? ""));
  const sessions: Record<string, string>[][] = [];
  let cur: Record<string, string>[] = [];
  let lastMs: number | null = null;
  for (const r of sorted) {
    const iso = toRfc3339(r.Date ?? "", off);
    const ms = iso ? Date.parse(iso) : Number.NaN;
    if (cur.length > 0 && lastMs !== null && Number.isFinite(ms) && (ms - lastMs) / 1000 > SESSION_GAP_S) {
      sessions.push(cur);
      cur = [];
    }
    cur.push(r);
    if (Number.isFinite(ms)) lastMs = ms;
  }
  if (cur.length > 0) sessions.push(cur);

  const records: LiveRecord[] = [];
  for (const srows of sessions) {
    const f = srows[0];
    if (f === undefined) continue; // unreachable: sessions are pushed non-empty
    const last = srows[srows.length - 1] ?? f;
    const start = toRfc3339(f.Date ?? "", off);
    // Fitbod has no workout duration; endTime is the last set's start + its own Duration.
    const end =
      start === undefined
        ? undefined
        : (addSeconds(toRfc3339(last.Date ?? "", off), num(last["Duration(s)"]) ?? 0, off) ?? start);
    if (start === undefined)
      warnings.push({
        code: "unparseable-date",
        message: `a Fitbod session has a blank or unparseable first Date ("${f.Date ?? ""}") — startTime/endTime omitted`,
        context: { mapper: "fitbod", date: f.Date ?? "" },
      });

    // The first set's timestamp is the session's stable natural key (§7.1): a hash of it
    // survives re-export, where positional numbering would renumber everything.
    const key = f.Date ?? "";
    const session: Session = {
      id: `fitbod-w-${contentHash(key)}`,
      recordType: "Session",
      subject,
      clientRecordId: key,
      disciplines: ["strength"],
      ...(start !== undefined ? { startTime: start } : {}),
      ...(end !== undefined ? { endTime: end } : {}),
      exercises: [] as Exercise[],
    };

    const exGroups: { name: string | undefined; sets: Record<string, string>[] }[] = [];
    for (const r of srows) {
      const grp = exGroups[exGroups.length - 1];
      if (grp && grp.name === r.Exercise) grp.sets.push(r);
      else exGroups.push({ name: r.Exercise, sets: [r] });
    }

    session.exercises = exGroups.map((g, i) => ({
      id: `${session.id}-ex${i}`,
      recordType: "Exercise",
      // §6.5 ladder: canonical id via the registry crosswalk where one resolves, else the
      // original Fitbod name preserved losslessly in `opaque` (src/resolve.ts).
      exerciseRef: resolveExerciseRef(g.name ?? "", { source: "fitbod" }),
      workUnits: g.sets.map((s, j) => {
        const reps = num(s.Reps),
          wt = num(s["Weight(kg)"]),
          secs = num(s["Duration(s)"]),
          dist = num(s["Distance(m)"]);
        // §5.5: a non-`continuous` unit can't carry a metric that contradicts its scoring.
        // A cardio piece logging BOTH distance and time is `continuous` (both allowed);
        // otherwise the scoring is whichever single metric is populated.
        const scoring: WorkUnit["scoring"] = reps
          ? "reps"
          : dist && secs
            ? "continuous"
            : dist
              ? "distance"
              : secs
                ? "time"
                : "reps";
        const perf: Performance = {};
        if (reps) perf.reps = reps;
        if (wt) perf.load = { value: wt, unit: "kg", basis: "marked_weight" };
        if (dist && (scoring === "distance" || scoring === "continuous"))
          perf.distance = { absolute: { value: dist, unit: "m" } };
        if (secs && (scoring === "time" || scoring === "continuous")) perf.time = secs;
        const wu: WorkUnit = {
          id: `${session.id}-ex${i}-set${j}`,
          recordType: "WorkUnit",
          scoring,
          performance: perf,
        };
        if (s.Note) wu.notes = s.Note;
        // Fitbod-only fields with no core home → a lossless namespaced extension (§8.1).
        const ext: Record<string, unknown> = {};
        const incline = num(s.Incline),
          resistance = num(s.Resistance),
          multiplier = num(s.multiplier);
        if (isTrue(s.isWarmup)) ext.warmup = true;
        if (incline !== undefined && incline !== 0) ext.incline = incline;
        if (resistance !== undefined && resistance !== 0) ext.resistance = resistance;
        if (multiplier !== undefined && multiplier !== 1) ext.multiplier = multiplier;
        if (Object.keys(ext).length > 0) wu.extension = { "com.fitbod.export": ext };
        return wu;
      }),
    }));
    records.push(session);
  }
  return { records, warnings };
}
