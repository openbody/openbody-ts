// OpenBody Session/Exercise/WorkUnit records → a Strong-importable CSV file. This is the
// mirror of `mapStrong` (strong.ts): where that mapper reads Strong's export/import CSV
// shape into OpenBody wire records, this one writes that same CSV shape back out.
//
// v1 scope — the overwhelmingly common Strong case only:
//   - one row per WorkUnit, grouped under `Session.exercises[].workUnits[]`
//   - `WorkUnit.scoring === "reps"` (resistance training: reps ± an absolute `load` in kg)
//
// Explicitly OUT of scope for this first outbound mapper (throws a clear error instead of
// silently dropping data — see README for follow-up):
//   - `Session.blocks` (supersets, `Block.roundScheme`, or any other block-level container —
//     Strong's flat CSV has no superset/round concept to write these back into)
//   - non-`"reps"` scoring kinds (`time`, `distance`, `energy`, `continuous` — Strong CSV's
//     Distance/Seconds columns exist and are *read* by `mapStrong`, but round-tripping
//     cardio-style sets is left to a follow-up rather than bolted on here)
//   - `load` targets other than a plain absolute value in kg (ranges, ramps, non-kg units —
//     `mapStrong` itself always assumes the Weight column is kg, so this mapper mirrors that)
//   - `prescription`, `sets` expansion, `setRole`, `repDetail`, `effortLoad`/RPE, and any
//     other WorkUnit fields Strong's CSV has no column for
import { type OpenBodyRecord, type MapOptions } from "./csv.js";

const HEADER = ["Date", "Workout Name", "Duration", "Exercise Name", "Set Order", "Weight", "Reps", "Distance", "Seconds", "Notes", "Workout No"];

// RFC 8785/3339 "…T…Z" → Strong's "YYYY-MM-DD HH:MM:SS" (inverse of the `f.Date.replace(" ",
// "T") + "Z"` step in strong.ts). Assumes no UTC offset and no fractional seconds, matching
// what `mapStrong` itself produces.
function toStrongDate(iso: string | undefined): string {
  if (!iso) return "";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "").replace(/Z$/, "");
}

// Accepts a plain number or anything else that stringifies to a decimal (e.g. a
// LosslessNumber) — see csv.ts's `num()` for the inbound-direction equivalent.
function toNum(v: any): number | undefined {
  return v === null || v === undefined ? undefined : Number(v);
}

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Map OpenBody wire records (Sessions of resistance-training Exercises/WorkUnits) to a
 * Strong-importable CSV string. See the file header for v1 scope/limitations. */
export function mapOpenBodyToStrong(records: OpenBodyRecord[], _opts: MapOptions = {}): string {
  const rows: string[][] = [];
  let wIdx = 0;

  for (const session of records) {
    if (session.recordType !== "Session") continue;
    wIdx++;
    if (session.blocks !== undefined) {
      throw new Error(`mapOpenBodyToStrong: Session ${session.id ?? "?"} uses blocks (supersets/roundScheme), which is out of scope for v1 — see to-strong.ts header`);
    }

    const date = toStrongDate(session.startTime);
    const duration = session.startTime && session.endTime
      ? Math.round((new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 1000)
      : 0;
    const workoutNo = session.extension?.["io.strong.export"]?.workoutNo ?? String(wIdx);

    const exercises: OpenBodyRecord[] = session.exercises ?? [];
    for (const ex of exercises) {
      if (ex.recordType !== "Exercise") continue;
      const er = ex.exerciseRef;
      const name = typeof er === "string" ? er : er?.opaque ?? er?.id ?? "";
      const workUnits: OpenBodyRecord[] = ex.workUnits ?? [];

      workUnits.forEach((wu, j) => {
        if (wu.recordType !== "WorkUnit") return;
        if (wu.scoring !== "reps") {
          throw new Error(`mapOpenBodyToStrong: WorkUnit ${wu.id ?? "?"} has scoring "${wu.scoring}", which is out of scope for v1 (reps-only) — see to-strong.ts header`);
        }
        const perf = wu.performance ?? {};
        const reps = toNum(perf.reps) ?? 0;
        const weight = perf.load ? toNum(perf.load.value) ?? 0 : 0;
        rows.push([date, session.name ?? "", String(duration), name, String(j + 1), String(weight), String(reps), "0", "0", wu.notes ?? "", String(workoutNo)]);
      });
    }
  }

  const lines = [HEADER, ...rows].map((r) => r.map(csvEscape).join(","));
  return lines.join("\n") + "\n";
}
