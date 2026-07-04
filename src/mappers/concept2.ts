// Concept2 Logbook (log.concept2.com) season CSV export → OpenBody Session/Block/WorkUnit
// records (one Session per logbook row), plus an avg-HR Measurement per workout.
//
// Format sources — built against the publicly documented export format; verify with a real
// export (OB-81 acceptance):
//   - Season CSV header ("Log ID",Date,Description,"Work Time (Formatted)","Work Time
//     (Seconds)","Rest Time (Formatted)","Rest Time (Seconds)","Work Distance","Rest
//     Distance","Stroke Rate/Cadence","Stroke Count",Pace,"Avg Watts",Cal/Hour,"Total
//     Cal","Avg Heart Rate","Drag Factor",Age,Weight,Type,Ranked,Comments,"Date Entered")
//     verified against a real export published in
//     https://github.com/manderly/c2-erg-best (public/concept2-season-2024.csv) and the
//     column list discussed on the Concept2 forum:
//     https://www.c2forum.com/viewtopic.php?t=209780 ("Logbook column changes") and
//     https://www.c2forum.com/viewtopic.php?t=202783 ("csv download from Concept2 logbook").
//   - Machine types (Type column): RowErg / SkiErg / BikeErg (log.concept2.com workout
//     types; https://log.concept2.com/help, https://www.concept2.com/community/online-logbook).
//   - Interval workouts: the season CSV is ONE ROW PER WORKOUT — there are no per-interval
//     detail rows in it (verified on the real export above; per-interval/per-stroke actuals
//     are only available from the per-workout "Download Stroke Data" CSV and the Logbook
//     API, https://www.c2forum.com/viewtopic.php?t=200753). Fixed-interval structure IS
//     recoverable from the Description ("8x500m/0:30r row", "4x5:00/1:00r row"), which the
//     PM5 generates deterministically, so those expand to a Block of per-interval WorkUnits
//     with `rest`; variable-interval workouts ("v2000m/3:00r...3") only disclose the first
//     interval + a count, so they degrade to a single continuous WorkUnit with the rest
//     totals preserved as residue (canonical-plus-residue, same policy as fit.ts).
//
// Mapping decisions (documented per the mapper-header convention):
//   - Piece scoring is inferred from Description vs the work totals: "2000m row" whose
//     Work Distance is exactly 2000 ⇒ a fixed-distance piece (scoring `distance`);
//     "30:00 ski" whose Work Time is exactly 1800.0 ⇒ fixed-time (scoring `time`);
//     anything else (a "just row/ski/ride" ends at an arbitrary point) ⇒ `continuous`,
//     which per §5.5 MAY carry time + distance + energy together.
//   - §5.5 forbids a non-`continuous` WorkUnit carrying a metric that contradicts its
//     scoring kind, so a fixed-distance piece's elapsed time (and a fixed-time piece's
//     distance) is preserved losslessly in `extension.concept2` rather than as a second
//     metric field (the corpus precedent: hyrox runs carry distance+time only under
//     `continuous`; the 500 m row vector carries distance alone).
//   - Stroke rate → `performance.intensity` `{ dimension: "cadence", unit: "/min" }` on a
//     single-piece WorkUnit: §5.13 places achieved non-resistance intensity in `intensity`,
//     and the registry's intensity-dimension vocabulary lists `cadence` with alias
//     "stroke rate". Avg Watts rides the same rail (dimension `power`). For interval
//     workouts the CSV's stroke rate/watts are whole-workout averages; asserting them on
//     any single interval would fabricate per-interval data, and Block carries no
//     `intensity` (§5.4), so they land in `extension.concept2` instead.
//   - Avg Heart Rate → a Pillar A Measurement (`heart_rate_mean`, strava.ts precedent)
//     spanning the workout window, linked from the Session via `measuredBy` (§7.2).
//   - Machine type → discipline: RowErg/rower ⇒ `rowing` (canon token), BikeErg ⇒
//     `cycling` (canon), SkiErg ⇒ `concept2:skierg` (no canon skierg discipline —
//     namespaced fallback per §5.9; `skiing` would misstate an indoor erg). exerciseRef:
//     RowErg ⇒ `row.erg`, SkiErg ⇒ `ski.erg` (both verified in the registry); BikeErg has
//     no canonical registry id (the registry's `air-bike` is a fan bike, `cycling` a road
//     ride), so it stays opaque-only. The raw Type string always rides in
//     `exerciseRef.opaque` (§6.5 lossless floor).

import type {
  Block,
  ExerciseRefObject,
  Intensity,
  LiveRecord,
  MapOptions,
  MapperResult,
  MapWarning,
  Performance,
  Provenance,
  Session,
  WorkUnit,
} from "../types.js";
import { addSeconds, num, parseCsvDoc, requireColumns, toRfc3339 } from "./csv.js";
import { subjectFor } from "./shared.js";

/** "21:31.9" / "3:00" / "1:00:00" → seconds (undefined for blank/unparseable). */
function parseClock(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const parts = s.trim().split(":");
  if (parts.some((p) => p === "" || Number.isNaN(Number(p)))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

const MACHINE: Record<string, { discipline: string; exerciseId?: string }> = {
  rowerg: { discipline: "rowing", exerciseId: "row.erg" },
  rower: { discipline: "rowing", exerciseId: "row.erg" }, // pre-2021 type token
  slides: { discipline: "rowing", exerciseId: "row.erg" },
  dynamic: { discipline: "rowing", exerciseId: "row.erg" },
  skierg: { discipline: "concept2:skierg", exerciseId: "ski.erg" },
  bikeerg: { discipline: "cycling" }, // no canonical BikeErg registry id — opaque-only
  bike: { discipline: "cycling" },
  water: { discipline: "rowing" }, // on-water rowing: right discipline, not an erg
  paddle: { discipline: "paddling" },
  snow: { discipline: "skiing" },
};

type Piece =
  | { kind: "single"; scoring: "time" | "distance" | "continuous" }
  | {
      kind: "intervals";
      /** Interval count. */
      n: number;
      childScoring: "time" | "distance";
      /** Metres or seconds per interval. */
      childValue?: number;
      /** Rest per interval. */
      restSec?: number;
    }
  | { kind: "variable" };

/** Infer the workout structure from the PM5-generated Description (see file header). */
function inferPiece(
  desc: string,
  workSec: number | undefined,
  workDist: number | undefined,
  restSec: number | undefined,
): Piece {
  const d = desc.trim();
  const mDist = d.match(/^(\d+)x([\d,]+)m(?:\/(\d+(?::\d+)*)r)?/);
  if (mDist) {
    const [, nStr = "", valStr = "", restStr] = mDist; // groups 1-2 always match; defaults only satisfy the checker
    const n = Number(nStr);
    return {
      kind: "intervals",
      n,
      childScoring: "distance",
      childValue: Number(valStr.replace(/,/g, "")),
      restSec: parseClock(restStr) ?? (restSec && n ? restSec / n : undefined),
    };
  }
  const mTime = d.match(/^(\d+)x(\d+(?::\d+)+)(?:\/(\d+(?::\d+)*)r)?/);
  if (mTime) {
    const n = Number(mTime[1]);
    return {
      kind: "intervals",
      n,
      childScoring: "time",
      childValue: parseClock(mTime[2]),
      restSec: parseClock(mTime[3]) ?? (restSec && n ? restSec / n : undefined),
    };
  }
  if (/^v/.test(d)) return { kind: "variable" };
  const mFixedDist = d.match(/^([\d,]+)m\b/);
  if (mFixedDist && Number((mFixedDist[1] ?? "").replace(/,/g, "")) === workDist)
    return { kind: "single", scoring: "distance" };
  const mFixedTime = d.match(/^(\d+(?::\d+)+)\b/);
  if (mFixedTime && parseClock(mFixedTime[1]) === workSec) return { kind: "single", scoring: "time" };
  return { kind: "single", scoring: "continuous" }; // a "just row" ends wherever it ends
}

/** Everything the per-row mapper shares for one `mapConcept2` call. */
interface Concept2Ctx {
  subject: string;
  /** Raw opts.utcOffset — the "Z" default is applied by toRfc3339/addSeconds and locally. */
  utcOffset: string | undefined;
  warnings: MapWarning[];
  records: LiveRecord[];
}

// Fixed intervals: the PM5 enforces the per-interval work value, so expanding the
// Description into per-interval WorkUnits asserts only machine-guaranteed facts. Rest
// follows every interval on a PM5 (total rest = n × rest), so each child gets it.
function buildIntervalBlock(
  sid: string,
  exerciseRef: ExerciseRefObject,
  piece: Extract<Piece, { kind: "intervals" }>,
  childValue: number,
  description: string,
): Block {
  const { childScoring, restSec: perIntervalRest } = piece;
  const children = Array.from({ length: piece.n }, (_, j): WorkUnit => {
    const perf: Performance =
      childScoring === "distance"
        ? { distance: { absolute: { value: childValue, unit: "m" } } }
        : { time: { absolute: { value: childValue, unit: "s" } } };
    if (perIntervalRest) perf.rest = { absolute: { value: perIntervalRest, unit: "s" } };
    return { id: `${sid}-int${j + 1}`, recordType: "WorkUnit", exerciseRef, scoring: childScoring, performance: perf };
  });
  return { id: `${sid}-blk`, recordType: "Block", ...(description ? { name: description } : {}), children };
}

/** The single-piece (fixed-distance/fixed-time/continuous) WorkUnit for a workout row. */
function buildSingleWorkUnit(
  sid: string,
  exerciseRef: ExerciseRefObject,
  piece: Piece,
  totals: { workDist?: number; workSec?: number; totalCal?: number; intensity: Intensity[] },
): WorkUnit {
  const { workDist, workSec, totalCal, intensity } = totals;
  // A "single" piece always carries a scoring from inferPiece; "continuous" is the honest
  // degradation for any shape that somehow reaches here without one.
  const scoring = piece.kind === "single" ? piece.scoring : "continuous";
  const perf: Performance = {};
  // inferPiece invariant: it only returns "distance"/"time" scoring after matching the
  // Description against that same defined work total, so these casts never see undefined.
  if (scoring === "distance") perf.distance = { absolute: { value: workDist as number, unit: "m" } };
  else if (scoring === "time") perf.time = { absolute: { value: workSec as number, unit: "s" } };
  else {
    if (workDist != null) perf.distance = { absolute: { value: workDist, unit: "m" } };
    if (workSec != null) perf.time = { absolute: { value: workSec, unit: "s" } };
    if (totalCal) perf.energy = { absolute: { value: totalCal, unit: "kcal" } };
  }
  if (intensity.length) perf.intensity = intensity;
  return { id: `${sid}-wu`, recordType: "WorkUnit", exerciseRef, scoring, performance: perf };
}

/** Map one Concept2 season-CSV row to its Session (+ optional linked avg-HR Measurement). */
function rowToRecords(row: Record<string, string>, index: number, ctx: Concept2Ctx): void {
  const logId = row["Log ID"] || String(index + 1);
  const sid = `c2-${logId}`;
  const rawType = row["Type"] ?? "";
  const machine = MACHINE[rawType.toLowerCase()] ?? { discipline: `concept2:${rawType.toLowerCase() || "unknown"}` };
  const exerciseRef: ExerciseRefObject = machine.exerciseId
    ? { id: machine.exerciseId, opaque: rawType }
    : { opaque: rawType || "erg" };

  const workSec = num(row["Work Time (Seconds)"]);
  const workDist = num(row["Work Distance"]);
  const restSec = num(row["Rest Time (Seconds)"]) ?? parseClock(row["Rest Time (Formatted)"]);
  const restDist = num(row["Rest Distance"]);
  const strokeRate = num(row["Stroke Rate/Cadence"]);
  const avgWatts = num(row["Avg Watts"]);
  const avgHr = num(row["Avg Heart Rate"]);
  const totalCal = num(row["Total Cal"]);
  const piece = inferPiece(row["Description"] ?? "", workSec, workDist, restSec);

  const start = toRfc3339(row["Date"] ?? "", ctx.utcOffset); // Date is offset-less local wall-clock
  const elapsed = (workSec ?? 0) + (restSec ?? 0);
  const off = ctx.utcOffset ?? "Z";
  // start + elapsed = end (see csv.addSeconds); undefined when the Date cell is blank/
  // unparseable — degrade by omitting endTime + warning (never throw, src/errors.ts).
  const end = addSeconds(start, Math.round(elapsed), off);
  if (end === undefined)
    ctx.warnings.push({
      code: "unparseable-date",
      message: `row "${logId}" has a blank or unparseable Date ("${row["Date"] ?? ""}") — endTime omitted`,
      context: { mapper: "concept2", clientRecordId: logId, date: row["Date"] ?? "" },
    });
  const prov: Provenance = {
    method: "sensor",
    sourceApp: "concept2",
    ...(rawType ? { device: { manufacturer: "concept2", model: rawType } } : {}),
  };

  // Whole-workout achieved intensity (§5.13) — only honest on a single piece (see header).
  const intensity: Intensity[] = [];
  if (piece.kind === "single") {
    if (strokeRate) intensity.push({ dimension: "cadence", unit: "/min", value: { absolute: { value: strokeRate } } });
    if (avgWatts) intensity.push({ dimension: "power", unit: "W", value: { absolute: { value: avgWatts } } });
  }

  // Residue (extension.concept2): every summary column that has no honest core home here.
  const ext: Record<string, unknown> = {};
  if (row["Pace"]) ext.pace = row["Pace"]; // /500m (RowErg/SkiErg) or /1000m (BikeErg)
  if (num(row["Stroke Count"])) ext.strokeCount = num(row["Stroke Count"]);
  if (num(row["Cal/Hour"])) ext.calHour = num(row["Cal/Hour"]);
  if (num(row["Drag Factor"])) ext.dragFactor = num(row["Drag Factor"]);
  if (piece.kind !== "single" && strokeRate) ext.avgStrokeRate = strokeRate; // workout average — see header
  if (piece.kind !== "single" && avgWatts) ext.avgWatts = avgWatts;
  if (restDist) ext.restDistance = restDist;
  if (piece.kind === "variable" && restSec) ext.restTimeSeconds = restSec;
  // `piece.scoring` exists only on single pieces (the Piece union above), matching the old
  // optional-field reads: any non-single kind fell through these guards unchanged.
  const singleScoring = piece.kind === "single" ? piece.scoring : undefined;
  if (singleScoring === "distance" && workSec != null) ext.workTimeSeconds = workSec; // the piece's result time (§5.5 — see header)
  if (singleScoring === "time" && workDist != null) ext.workDistance = workDist;
  if (totalCal && singleScoring !== "continuous") ext.totalCal = totalCal;

  const session: Session = {
    id: sid,
    recordType: "Session",
    subject: ctx.subject,
    clientRecordId: logId,
    ...(row["Description"] ? { name: row["Description"] } : {}),
    ...(row["Comments"] ? { notes: row["Comments"] } : {}),
    disciplines: [machine.discipline],
    intent: "train",
    startTime: start,
    ...(end !== undefined ? { endTime: end } : {}),
    provenance: prov,
  };

  if (piece.kind === "intervals" && piece.n && piece.childValue != null) {
    session.blocks = [buildIntervalBlock(sid, exerciseRef, piece, piece.childValue, row["Description"] ?? "")];
  } else {
    session.workUnits = [buildSingleWorkUnit(sid, exerciseRef, piece, { workDist, workSec, totalCal, intensity })];
  }

  if (avgHr) {
    ctx.records.push({
      id: `${sid}-hr`,
      recordType: "Measurement",
      subject: ctx.subject,
      type: "heart_rate_mean",
      quantity: avgHr,
      unit: "/min",
      startTime: start,
      ...(end !== undefined ? { endTime: end } : {}),
      provenance: prov,
    });
    session.links = [{ type: "measuredBy", ref: `${sid}-hr` }];
  }
  if (Object.keys(ext).length) session.extension = { concept2: ext };
  ctx.records.push(session);
}

/**
 * Map a Concept2 Logbook season CSV export to OpenBody wire records: one Session per
 * row, its workout structure inferred from the PM5-generated `Description` (a single
 * fixed-distance/fixed-time/continuous piece, or fixed-interval sets expanded into a
 * `Block` of per-interval WorkUnits with `rest` — see the file header for the
 * inference rules and the piece-vs-scoring table), plus a linked `heart_rate_mean`
 * Measurement when `Avg Heart Rate` is present.
 *
 * Input precondition: the CSV's header row must carry a `Date` column — anything
 * else throws `MapperInputError` (`mapper: "concept2"`).
 *
 * `opts.utcOffset` stamps the CSV's offset-less local-wall-clock `Date` column
 * (default `"Z"`).
 *
 * Warnings this mapper can emit: `default-subject` (no `opts.subject` given),
 * `unparseable-date` (a row's `Date` cell is blank/garbled, so `endTime` is omitted).
 */
export function mapConcept2(csv: string, opts: MapOptions = {}): MapperResult {
  const warnings: MapWarning[] = [];
  const subject = subjectFor(opts, warnings, "concept2");
  const { header, rows } = parseCsvDoc(csv);
  // Structural minimum (WP7): every row's window hangs off Date — without the column
  // this is not a Concept2 season export (was a raw RangeError from Date arithmetic).
  requireColumns("concept2", header, ["Date"]);
  const records: LiveRecord[] = [];

  const ctx: Concept2Ctx = { subject, utcOffset: opts.utcOffset, warnings, records };
  rows.forEach((row, i) => {
    rowToRecords(row, i, ctx);
  });

  return { records, warnings };
}
