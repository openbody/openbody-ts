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
import { parseCsv, num, toRfc3339, type OpenBodyRecord, type MapOptions } from "./csv.js";

/** "21:31.9" / "3:00" / "1:00:00" → seconds (undefined for blank/unparseable). */
function parseClock(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const parts = s.trim().split(":");
  if (parts.some((p) => p === "" || isNaN(Number(p)))) return undefined;
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

interface Piece {
  kind: "single" | "intervals" | "variable";
  scoring?: "time" | "distance" | "continuous"; // single pieces
  n?: number; // interval count
  childScoring?: "time" | "distance";
  childValue?: number; // metres or seconds per interval
  restSec?: number; // rest per interval
}

/** Infer the workout structure from the PM5-generated Description (see file header). */
function inferPiece(desc: string, workSec: number | undefined, workDist: number | undefined, restSec: number | undefined): Piece {
  const d = desc.trim();
  const mDist = d.match(/^(\d+)x([\d,]+)m(?:\/(\d+(?::\d+)*)r)?/);
  if (mDist) {
    const n = Number(mDist[1]);
    return { kind: "intervals", n, childScoring: "distance", childValue: Number(mDist[2].replace(/,/g, "")),
      restSec: parseClock(mDist[3]) ?? (restSec && n ? restSec / n : undefined) };
  }
  const mTime = d.match(/^(\d+)x(\d+(?::\d+)+)(?:\/(\d+(?::\d+)*)r)?/);
  if (mTime) {
    const n = Number(mTime[1]);
    return { kind: "intervals", n, childScoring: "time", childValue: parseClock(mTime[2]),
      restSec: parseClock(mTime[3]) ?? (restSec && n ? restSec / n : undefined) };
  }
  if (/^v/.test(d)) return { kind: "variable" };
  const mFixedDist = d.match(/^([\d,]+)m\b/);
  if (mFixedDist && Number(mFixedDist[1].replace(/,/g, "")) === workDist) return { kind: "single", scoring: "distance" };
  const mFixedTime = d.match(/^(\d+(?::\d+)+)\b/);
  if (mFixedTime && parseClock(mFixedTime[1]) === workSec) return { kind: "single", scoring: "time" };
  return { kind: "single", scoring: "continuous" }; // a "just row" ends wherever it ends
}

/** Map a Concept2 Logbook season CSV export to OpenBody wire records (one Session per row). */
export function mapConcept2(csv: string, opts: MapOptions = {}): OpenBodyRecord[] {
  const subject = opts.subject ?? "subj-001";
  const rows = parseCsv(csv);
  const records: OpenBodyRecord[] = [];

  rows.forEach((r, i) => {
    const logId = r["Log ID"] || String(i + 1);
    const sid = `c2-${logId}`;
    const rawType = r["Type"] ?? "";
    const machine = MACHINE[rawType.toLowerCase()] ?? { discipline: `concept2:${rawType.toLowerCase() || "unknown"}` };
    const exerciseRef: OpenBodyRecord = machine.exerciseId
      ? { id: machine.exerciseId, opaque: rawType }
      : { opaque: rawType || "erg" };

    const workSec = num(r["Work Time (Seconds)"]);
    const workDist = num(r["Work Distance"]);
    const restSec = num(r["Rest Time (Seconds)"]) ?? parseClock(r["Rest Time (Formatted)"]);
    const restDist = num(r["Rest Distance"]);
    const strokeRate = num(r["Stroke Rate/Cadence"]);
    const avgWatts = num(r["Avg Watts"]);
    const avgHr = num(r["Avg Heart Rate"]);
    const totalCal = num(r["Total Cal"]);
    const piece = inferPiece(r["Description"] ?? "", workSec, workDist, restSec);

    const start = toRfc3339(r["Date"]);
    const elapsed = (workSec ?? 0) + (restSec ?? 0);
    const end = new Date(new Date(start).getTime() + Math.round(elapsed) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const prov = { method: "sensor", sourceApp: "concept2", ...(rawType ? { device: { manufacturer: "concept2", model: rawType } } : {}) };

    // Whole-workout achieved intensity (§5.13) — only honest on a single piece (see header).
    const intensity: OpenBodyRecord[] = [];
    if (piece.kind === "single") {
      if (strokeRate) intensity.push({ dimension: "cadence", unit: "/min", value: { absolute: { value: strokeRate } } });
      if (avgWatts) intensity.push({ dimension: "power", unit: "W", value: { absolute: { value: avgWatts } } });
    }

    // Residue (extension.concept2): every summary column that has no honest core home here.
    const ext: OpenBodyRecord = {};
    if (r["Pace"]) ext.pace = r["Pace"]; // /500m (RowErg/SkiErg) or /1000m (BikeErg)
    if (num(r["Stroke Count"])) ext.strokeCount = num(r["Stroke Count"]);
    if (num(r["Cal/Hour"])) ext.calHour = num(r["Cal/Hour"]);
    if (num(r["Drag Factor"])) ext.dragFactor = num(r["Drag Factor"]);
    if (piece.kind !== "single" && strokeRate) ext.avgStrokeRate = strokeRate; // workout average — see header
    if (piece.kind !== "single" && avgWatts) ext.avgWatts = avgWatts;
    if (restDist) ext.restDistance = restDist;
    if (piece.kind === "variable" && restSec) ext.restTimeSeconds = restSec;
    if (piece.scoring === "distance" && workSec != null) ext.workTimeSeconds = workSec; // the piece's result time (§5.5 — see header)
    if (piece.scoring === "time" && workDist != null) ext.workDistance = workDist;
    if (totalCal && piece.scoring !== "continuous") ext.totalCal = totalCal;

    const session: OpenBodyRecord = {
      id: sid, recordType: "Session", subject, clientRecordId: logId,
      ...(r["Description"] ? { name: r["Description"] } : {}),
      ...(r["Comments"] ? { notes: r["Comments"] } : {}),
      disciplines: [machine.discipline], intent: "train",
      startTime: start, endTime: end, provenance: prov,
    };

    if (piece.kind === "intervals" && piece.n && piece.childValue != null) {
      // Fixed intervals: the PM5 enforces the per-interval work value, so expanding the
      // Description into per-interval WorkUnits asserts only machine-guaranteed facts.
      // Rest follows every interval on a PM5 (total rest = n × rest), so each child gets it.
      const { childScoring, childValue, restSec: perIntervalRest } = piece;
      const children = Array.from({ length: piece.n }, (_, j) => {
        const perf: OpenBodyRecord =
          childScoring === "distance"
            ? { distance: { absolute: { value: childValue, unit: "m" } } }
            : { time: { absolute: { value: childValue, unit: "s" } } };
        if (perIntervalRest) perf.rest = { absolute: { value: perIntervalRest, unit: "s" } };
        return { id: `${sid}-int${j + 1}`, recordType: "WorkUnit", exerciseRef, scoring: childScoring, performance: perf };
      });
      session.blocks = [{ id: `${sid}-blk`, recordType: "Block", ...(r["Description"] ? { name: r["Description"] } : {}), children }];
    } else {
      const perf: OpenBodyRecord = {};
      const scoring = piece.kind === "variable" ? "continuous" : piece.scoring!;
      if (scoring === "distance") perf.distance = { absolute: { value: workDist, unit: "m" } };
      else if (scoring === "time") perf.time = { absolute: { value: workSec, unit: "s" } };
      else {
        if (workDist != null) perf.distance = { absolute: { value: workDist, unit: "m" } };
        if (workSec != null) perf.time = { absolute: { value: workSec, unit: "s" } };
        if (totalCal) perf.energy = { absolute: { value: totalCal, unit: "kcal" } };
      }
      if (intensity.length) perf.intensity = intensity;
      session.workUnits = [{ id: `${sid}-wu`, recordType: "WorkUnit", exerciseRef, scoring, performance: perf }];
    }

    if (avgHr) {
      records.push({
        id: `${sid}-hr`, recordType: "Measurement", subject, type: "heart_rate_mean",
        quantity: avgHr, unit: "/min", startTime: start, endTime: end, provenance: prov,
      });
      session.links = [{ type: "measuredBy", ref: `${sid}-hr` }];
    }
    if (Object.keys(ext).length) session.extension = { concept2: ext };
    records.push(session);
  });

  return records;
}
