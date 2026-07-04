// Fitbit (Google Takeout) → OpenBody wire records. Takeout is a *folder* of JSON files
// (`Takeout/Fitbit/Global Export Data/` in current exports; `Physical Activity/` etc. in
// older ones), so the input is a list of { name, text } files — any subset — and files are
// classified by basename, never by directory.
//
// ⚠ Built against the *publicly documented* Takeout structure — verify against a real
// Takeout before relying on it (OB-80 acceptance). Structure cross-checked against:
//   - FitOut importer sources (path patterns + raw samples for sleep/weight/exercise/
//     resting_heart_rate): https://github.com/kev-m/FitOut
//   - "My (very) personal data warehouse" (exercise-*.json + steps-*.json entries):
//     https://dev.to/saubury/my-very-personal-data-warehouse-fitbit-activity-analysis-with-duckdb-426l
//   - "A Closer Look at Fitbit Data" (full exercise record incl. heartRateZones; HR shape):
//     https://jrtechs.net/data-science/a-closer-look-at-fitbit-data
//   - "Parsing Fitbit HR from Google Takeout" (heart_rate-*.json; dateTime is UTC while
//     files are named by local day): https://medium.com/@abhik.ch6/parsing-fitbit-hr-from-google-takeout-9d9e98ce6aee
//   - Fitbit Web API sleep docs (levels.data/shortData/summary; stage values; 30s/60s
//     granularity): https://dev.fitbit.com/build/reference/web-api/sleep/get-sleep-log-by-date-range/
//   - MyDataHelps Fitbit sleep export format ("stages" vs "classic" level values):
//     https://support.mydatahelps.org/hc/en-us/articles/360049602813-Fitbit-Sleep-Log-Data-Export-Format
//
// File kinds handled (all arrays of objects):
//   exercise-<N>.json              activity logs (100 per file): logId, activityName,
//                                  startTime "MM/DD/YY HH:MM:SS", duration/activeDuration ms,
//                                  calories, steps, distance+distanceUnit, averageHeartRate,
//                                  heartRateZones[], activityLevel[], logType
//   steps-<date>.json              { dateTime "MM/DD/YY HH:MM:SS", value: "<count>" } per-minute buckets
//   heart_rate-<date>.json         { dateTime "MM/DD/YY HH:MM:SS" (UTC), value: { bpm, confidence } }
//   sleep-<date>.json              sleep logs: logId, startTime "YYYY-MM-DDTHH:MM:SS.000" (local),
//                                  duration ms, minutesAsleep, type "stages"|"classic",
//                                  levels: { data[], shortData[], summary{} }
//   weight-<date>.json             { logId, weight (lb — Takeout exports pounds), bmi, fat?,
//                                  date "MM/DD/YY", time "HH:MM:SS", source? }
//   resting_heart_rate-<date>.json { dateTime "MM/DD/YY 00:00:00", value: { date, value, error } }
//
// Timezone caveat: Takeout timestamps carry NO offset. heart_rate-*.json is documented as
// UTC (mapped with "Z"); everything else is local wall-clock time — pass opts.utcOffset
// (e.g. "-07:00") to stamp those, else they too default to "Z". Known deliberate loss: the
// per-sample HR `confidence` (0–3 quality flag) is dropped from the heart_rate sampleArray.
import { MapperInputError } from "../errors.js";
import type {
  Link,
  LiveRecord,
  MapOptions,
  MapperResult,
  MapWarning,
  Measurement,
  Performance,
  Provenance,
  WireRecord,
} from "../types.js";
import { makeDisciplineMapper, subjectFor } from "./shared.js";

export interface FitbitFile {
  name: string;
  text: string;
}
export interface FitbitMapOptions extends MapOptions {
  /** RFC 3339 offset for Takeout's offset-less local timestamps (e.g. "-07:00"). Default "Z". Not applied to heart_rate files (documented UTC). */
  utcOffset?: string;
}

// activityName → canonical discipline token (registry vocab/disciplines.json); namespaced fallback.
const DISC: Record<string, string> = {
  run: "running",
  running: "running",
  treadmill: "running",
  walk: "walking",
  walking: "walking",
  bike: "cycling",
  "outdoor bike": "cycling",
  spinning: "cycling",
  swim: "swimming",
  swimming: "swimming",
  hike: "hiking",
  hiking: "hiking",
  yoga: "yoga",
  pilates: "pilates",
  weights: "strength",
  "weight training": "strength",
  rowing: "rowing",
  "rowing machine": "rowing",
  tennis: "tennis",
};
const mapDiscipline = makeDisciplineMapper(DISC, "fitbit");
const disciplineFor = (name: string) => mapDiscipline(name.toLowerCase(), name.toLowerCase().replace(/\s+/g, "_"));

const DIST_UNIT: Record<string, string> = { Kilometer: "km", Mile: "[mi_i]", Meter: "m", Foot: "[ft_i]" };

// levels.data `level` → sleep_stage category, consistent with the measurement-type registry's
// sleep tokens (sleep_deep/sleep_light/sleep_rem/sleep_awake); "classic" logs pass through.
const STAGE: Record<string, string> = {
  deep: "deep",
  light: "light",
  rem: "rem",
  wake: "awake",
  asleep: "asleep",
  restless: "restless",
  awake: "awake",
};

// "MM/DD/YY HH:MM:SS" → local ISO "20YY-MM-DDTHH:MM:SS" (no offset yet).
const usToIso = (s: string): string | undefined => {
  const m = /^(\d\d)\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(s);
  return m ? `20${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}` : undefined;
};
const stripFrac = (iso: string) => iso.replace(/\.\d+$/, "");
// Fixed anchor for duration/offset arithmetic only (constant offset cancels in differences).
const epoch = (localIso: string) => Date.parse(`${stripFrac(localIso)}Z`);
const isoAt = (e: number) => new Date(e).toISOString().slice(0, 19);
// Exact decimal → §4.2 fixed-point (lossless for the ≤2-decimal values Fitbit exports).
const fixed = (n: number): number | { coefficient: number; exponent: number } => {
  const s = String(n);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return n;
  const dot = s.indexOf(".");
  return dot < 0
    ? { coefficient: n, exponent: 0 }
    : { coefficient: Number(s.replace(".", "")), exponent: dot + 1 - s.length };
};

const basename = (name: string) => name.split("/").pop() ?? name;

const prov = (method: Provenance["method"]): Provenance => ({ method, sourceApp: "fitbit" });
// §7.4: derived summaries Fitbit computed on-device/server; version is not published.
const summaryAlg = (name: string): Provenance => ({
  method: "algorithm",
  sourceApp: "fitbit",
  algorithm: { name, version: "takeout" },
});

// levels.summary.<stage>.minutes → registry sleep-duration token (whole-night quantities).
const SLEEP_SUMMARY: Record<string, string> = {
  deep: "sleep_deep",
  light: "sleep_light",
  rem: "sleep_rem",
  wake: "sleep_awake",
};

// One intraday sample: `e` epoch-ms (for bucketing/offset math), `iso` its local spelling, `v` the value.
type Sample = { e: number; iso: string; v: number };
// One contiguous sleep segment on the night's timeline.
type SleepSegment = { s: number; e: number; level: string };

/** Everything the per-file-kind handlers share for one `mapFitbitTakeout` call. */
interface FitbitCtx {
  subject: string;
  /** Offset stamped on offset-less local timestamps (opts.utcOffset ?? "Z"). */
  off: string;
  records: LiveRecord[];
  warnings: MapWarning[];
  /** Count one entry skipped for missing required fields (flushed to a per-file warning by the caller). */
  skipEntry: () => void;
}

/** Push a Measurement, stamping the shared recordType/subject so callers pass only the varying fields. */
function pushMeasurement(ctx: FitbitCtx, fields: Omit<Measurement, "recordType" | "subject">): void {
  ctx.records.push({ recordType: "Measurement", subject: ctx.subject, ...fields });
}

// exercise-<N>.json → a Session (continuous WorkUnit) + measuredBy HR-mean/steps aggregates.
function mapExerciseLog(entries: WireRecord[], ctx: FitbitCtx, fileName: string): void {
  for (const entry of entries) {
    const startIso = usToIso(String(entry.startTime ?? ""));
    if (entry.logId == null || !startIso) {
      ctx.skipEntry();
      continue;
    }
    const durMs = Number(entry.activeDuration ?? entry.duration ?? 0);
    const start = startIso + ctx.off;
    const end = isoAt(epoch(startIso) + durMs) + ctx.off;
    const sid = `fitbit-ex-${entry.logId}`;
    const measuredBy: Link[] = [];
    if (entry.averageHeartRate != null) {
      pushMeasurement(ctx, {
        id: `${sid}-hr-mean`,
        type: "heart_rate_mean",
        quantity: entry.averageHeartRate,
        unit: "/min",
        startTime: start,
        endTime: end,
        provenance: summaryAlg("fitbit-activity-summary"),
      });
      measuredBy.push({ type: "measuredBy", ref: `${sid}-hr-mean` });
    }
    if (entry.steps != null) {
      pushMeasurement(ctx, {
        id: `${sid}-steps`,
        type: "step_count",
        quantity: entry.steps,
        unit: "1",
        startTime: start,
        endTime: end,
        provenance: prov("sensor"),
      });
      measuredBy.push({ type: "measuredBy", ref: `${sid}-steps` });
    }
    const extra: Record<string, unknown> = {};
    const perf: Performance = { time: { absolute: { value: durMs / 1000, unit: "s" } } };
    if (entry.distance != null) {
      const unit = DIST_UNIT[entry.distanceUnit];
      // Unrecognized distanceUnit: relabeling it km would fabricate data — the raw
      // value+unit pair rides the extension.fitbit residue rail instead (and the
      // routing is reported on the warnings channel).
      if (unit) perf.distance = { absolute: { value: entry.distance, unit } };
      else {
        extra.distance = entry.distance;
        if (entry.distanceUnit != null) extra.distanceUnit = entry.distanceUnit;
        ctx.warnings.push({
          code: "unknown-distance-unit",
          message: `${fileName}: activity ${entry.logId} carries an unrecognized distanceUnit ${JSON.stringify(entry.distanceUnit ?? null)} — distance kept as raw residue in extension.fitbit, not mapped to performance.distance`,
          context: { file: fileName, logId: String(entry.logId), distanceUnit: entry.distanceUnit ?? null },
        });
      }
    }
    if (entry.calories != null) perf.energy = { absolute: { value: entry.calories, unit: "kcal" } };
    if (Array.isArray(entry.heartRateZones) && entry.heartRateZones.length) extra.heartRateZones = entry.heartRateZones;
    if (Array.isArray(entry.activityLevel) && entry.activityLevel.length) extra.activityLevel = entry.activityLevel;
    if (entry.elevationGain != null) extra.elevationGain = entry.elevationGain;
    ctx.records.push({
      id: sid,
      recordType: "Session",
      subject: ctx.subject,
      clientRecordId: String(entry.logId),
      disciplines: [disciplineFor(String(entry.activityName ?? "unknown"))],
      intent: "train",
      startTime: start,
      endTime: end,
      provenance: prov(entry.logType === "manual" ? "manual" : "sensor"),
      ...(Object.keys(extra).length ? { extension: { fitbit: extra } } : {}),
      workUnits: [
        {
          id: `${sid}-wu`,
          recordType: "WorkUnit",
          scoring: "continuous",
          performance: perf,
          ...(measuredBy.length ? { links: measuredBy } : {}),
        },
      ],
    });
  }
}

// steps-<date>.json → intraday step samples (value must parse finite; a non-numeric cell
// would otherwise land NaN in the day's dataPoints — csv.ts num() discipline).
function collectSteps(entries: WireRecord[], ctx: FitbitCtx, bucket: Sample[]): void {
  for (const entry of entries) {
    const iso = usToIso(String(entry.dateTime ?? ""));
    const v = Number(entry.value);
    if (iso && entry.value != null && Number.isFinite(v)) bucket.push({ e: epoch(iso), iso, v });
    else ctx.skipEntry();
  }
}

// heart_rate-<date>.json → intraday HR samples (documented UTC; the day-series stamps "Z").
function collectHeartRate(entries: WireRecord[], ctx: FitbitCtx, bucket: Sample[]): void {
  for (const entry of entries) {
    const iso = usToIso(String(entry.dateTime ?? ""));
    if (iso && entry.value?.bpm != null) bucket.push({ e: epoch(iso), iso, v: entry.value.bpm });
    else ctx.skipEntry();
  }
}

// §4.3: a night of stages = category Measurements over ADJACENT intervals. levels.data is the
// contiguous timeline; levels.shortData (stages logs only) holds short (≤3 min) wakes that
// OVERLAP it — physiologically real, so splice each one in: punch it out of the underlying
// stage and insert an awake interval in its place.
function spliceShortWakes(segments: SleepSegment[], shortData: WireRecord[]): SleepSegment[] {
  let segs = segments;
  for (const sd of shortData) {
    const s = epoch(String(sd.dateTime));
    const e = s + Number(sd.seconds) * 1000;
    if (!Number.isFinite(s) || e <= s) continue;
    const next: SleepSegment[] = [{ s, e, level: String(sd.level) }];
    for (const g of segs) {
      if (e <= g.s || s >= g.e) {
        next.push(g);
        continue;
      }
      if (g.s < s) next.push({ s: g.s, e: s, level: g.level });
      if (e < g.e) next.push({ s: e, e: g.e, level: g.level });
    }
    segs = next.sort((a, b) => a.s - b.s);
  }
  return segs;
}

// sleep-<date>.json → adjacent sleep-stage category Measurements + Fitbit's own duration summaries.
function mapSleepLog(logs: WireRecord[], ctx: FitbitCtx): void {
  for (const log of logs) {
    if (log.logId == null || !log.startTime) {
      ctx.skipEntry();
      continue;
    }
    const lid = `fitbit-sleep-${log.logId}`;
    const start = stripFrac(String(log.startTime)) + ctx.off;
    const end = log.endTime
      ? stripFrac(String(log.endTime)) + ctx.off
      : isoAt(epoch(String(log.startTime)) + Number(log.duration ?? 0)) + ctx.off;
    const timeline: SleepSegment[] = (log.levels?.data ?? [])
      .map((d: WireRecord) => {
        const s = epoch(String(d.dateTime));
        return { s, e: s + Number(d.seconds) * 1000, level: String(d.level) };
      })
      .filter((g: SleepSegment) => Number.isFinite(g.s) && g.e > g.s)
      .sort((a: SleepSegment, b: SleepSegment) => a.s - b.s);
    const segs = spliceShortWakes(timeline, log.levels?.shortData ?? []);
    segs.forEach((g, i) => {
      pushMeasurement(ctx, {
        id: `${lid}-s${i}`,
        type: "sleep_stage",
        category: STAGE[g.level] ?? g.level,
        startTime: isoAt(g.s) + ctx.off,
        endTime: isoAt(g.e) + ctx.off,
        provenance: prov("sensor"),
      });
    });
    // Fitbit-computed summaries → registry sleep duration tokens (quantity over the window).
    if (log.minutesAsleep != null)
      pushMeasurement(ctx, {
        id: `${lid}-duration`,
        clientRecordId: String(log.logId),
        type: "sleep_duration",
        quantity: log.minutesAsleep,
        unit: "min",
        startTime: start,
        endTime: end,
        provenance: summaryAlg("fitbit-sleep-summary"),
      });
    for (const [stage, type] of Object.entries(SLEEP_SUMMARY)) {
      const mins = log.levels?.summary?.[stage]?.minutes;
      if (mins != null)
        pushMeasurement(ctx, {
          id: `${lid}-${stage}`,
          type,
          quantity: mins,
          unit: "min",
          startTime: start,
          endTime: end,
          provenance: summaryAlg("fitbit-sleep-summary"),
        });
    }
  }
}

// weight-<date>.json → body-mass ([lb_av], exact fixed-point) + bmi + body-fat Measurements.
function mapWeightLog(entries: WireRecord[], ctx: FitbitCtx): void {
  for (const entry of entries) {
    const iso = entry.date && entry.time ? usToIso(`${entry.date} ${entry.time}`) : undefined;
    if (entry.logId == null || !iso || entry.weight == null) {
      ctx.skipEntry();
      continue;
    }
    const t = iso + ctx.off;
    // Takeout weight is exported in pounds regardless of profile units (community-
    // documented); kept as UCUM [lb_av] rather than converted — lossless per §4.2.
    const aria = typeof entry.source === "string" && entry.source.toLowerCase() === "aria";
    const p: Provenance = {
      method: aria ? "sensor" : "manual",
      sourceApp: "fitbit",
      ...(aria ? { device: { manufacturer: "fitbit", model: entry.source } } : {}),
    };
    pushMeasurement(ctx, {
      id: `fitbit-weight-${entry.logId}`,
      clientRecordId: String(entry.logId),
      type: "body_mass",
      quantity: fixed(Number(entry.weight)),
      unit: "[lb_av]",
      startTime: t,
      endTime: t,
      provenance: p,
    });
    if (entry.bmi != null)
      pushMeasurement(ctx, {
        id: `fitbit-weight-${entry.logId}-bmi`,
        type: "bmi",
        quantity: fixed(Number(entry.bmi)),
        unit: "kg/m2",
        startTime: t,
        endTime: t,
        provenance: p,
      });
    if (entry.fat != null)
      pushMeasurement(ctx, {
        id: `fitbit-weight-${entry.logId}-fat`,
        type: "body_fat_percentage",
        quantity: fixed(Number(entry.fat)),
        unit: "%",
        startTime: t,
        endTime: t,
        provenance: p,
      });
  }
}

// resting_heart_rate-<date>.json → one daily resting-HR Measurement (a model estimate).
function mapRestingHeartRate(entries: WireRecord[], ctx: FitbitCtx): void {
  for (const entry of entries) {
    const iso = usToIso(String(entry.dateTime ?? ""));
    const v = entry.value?.value;
    if (v === 0) continue; // documented no-data marker — days without data export as 0, not a loss
    if (!iso || v == null) {
      ctx.skipEntry();
      continue;
    }
    const day = iso.slice(0, 10);
    pushMeasurement(ctx, {
      id: `fitbit-rhr-${day}`,
      type: "resting_heart_rate",
      quantity: v,
      unit: "/min",
      startTime: `${day}T00:00:00${ctx.off}`,
      endTime: isoAt(epoch(`${day}T00:00:00`) + 86400000) + ctx.off,
      provenance: prov("estimated"), // Fitbit RHR is a model estimate (the export carries an `error` term)
    });
  }
}

// Intraday per-minute/per-second entries accumulate across files, then emit one sampleArray
// per calendar day (§4.3) — point-by-point records would not scale.
function emitDaySeries(ctx: FitbitCtx, kind: "steps" | "heart_rate", entries: Sample[]): void {
  const tzOff = kind === "heart_rate" ? "Z" : ctx.off; // HR is documented UTC; the rest local
  const byDay = new Map<string, Sample[]>();
  for (const en of [...entries].sort((a, b) => a.e - b.e)) {
    const day = isoAt(en.e).slice(0, 10);
    let bucket = byDay.get(day);
    if (bucket === undefined) {
      bucket = [];
      byDay.set(day, bucket);
    }
    bucket.push(en);
  }
  for (const [day, ens] of byDay) {
    const first = ens[0];
    if (first === undefined) continue; // unreachable: buckets are created non-empty
    const last = ens[ens.length - 1] ?? first;
    pushMeasurement(ctx, {
      id: `fitbit-${kind === "steps" ? "steps" : "hr"}-${day}`,
      type: kind === "steps" ? "step_count" : "heart_rate",
      unit: kind === "steps" ? "1" : "/min",
      sampleArray: { offsets: ens.map((x) => (x.e - first.e) / 1000), dataPoints: ens.map((x) => x.v) },
      startTime: first.iso + tzOff,
      endTime: last.iso + tzOff,
      provenance: prov("sensor"),
    });
  }
}

/**
 * Map any subset of a Google Takeout Fitbit folder — an array of `{ name, text }`
 * JSON files, classified by basename regardless of directory — to OpenBody wire
 * records: activity logs → Sessions, steps/heart-rate → per-day `sampleArray`
 * series, sleep logs → adjacent sleep-stage category Measurements + duration
 * summaries, weight logs → body-mass/BMI/body-fat Measurements, resting-heart-rate
 * logs → daily Measurements. See the file header for the full file-kind table and
 * sourcing.
 *
 * Input precondition: `files` must be an array of `{ name: string, text: string }`
 * objects — anything else throws {@link MapperInputError} (`mapper: "fitbit"`). A
 * recognized-kind file whose text isn't a valid JSON array degrades to a warning +
 * skip, not a throw; only the top-level shape is a hard precondition.
 *
 * `opts.utcOffset` stamps every offset-less local-wall-clock timestamp (default
 * `"Z"`) — **except** `heart_rate-*.json`, which is documented UTC and is always
 * stamped `"Z"` regardless of this option.
 *
 * Warnings this mapper can emit: `default-subject` (no `opts.subject` given),
 * `skipped-file` (a recognized-kind file wasn't valid JSON, or wasn't a JSON array),
 * `skipped-entries` (per-file count of entries missing id/timestamp/value — reported
 * once per file), `unknown-distance-unit` (an activity's `distanceUnit` has no unit
 * mapping — distance kept as residue in `extension.fitbit` instead of
 * `performance.distance`), `unrecognized-file` (a file's basename matches none of the
 * documented Takeout kinds).
 */
export function mapFitbitTakeout(files: FitbitFile[], opts: FitbitMapOptions = {}): MapperResult {
  // Structural minimum (WP7): a list of { name, text } files — the documented input shape.
  if (!Array.isArray(files))
    throw new MapperInputError("fitbit", "input must be an array of { name, text } Takeout files");
  for (const f of files) {
    if (!f || typeof f.name !== "string" || typeof f.text !== "string")
      throw new MapperInputError("fitbit", "every input file must be a { name: string, text: string } object");
  }

  const warnings: MapWarning[] = [];
  const subject = subjectFor(opts, warnings, "fitbit");
  const records: LiveRecord[] = [];

  // Entries inside a recognized file that are missing the fields their encoding hangs
  // off (logId, a parseable timestamp, …) — counted per file, reported once per file.
  let skippedEntries = 0;
  const ctx: FitbitCtx = {
    subject,
    off: opts.utcOffset ?? "Z",
    records,
    warnings,
    skipEntry: () => {
      skippedEntries++;
    },
  };
  const flushSkippedEntries = (file: string) => {
    if (skippedEntries === 0) return;
    warnings.push({
      code: "skipped-entries",
      message: `${file}: ${skippedEntries} entr${skippedEntries === 1 ? "y" : "ies"} missing required fields (id/timestamp/value) — skipped`,
      context: { file, count: skippedEntries },
    });
    skippedEntries = 0;
  };

  // WireRecord-loose: raw Takeout JSON rows, not OpenBody records — accessed dynamically
  // by the handlers. A recognized-kind file that isn't a JSON array is skipped WITH a
  // warning (pre-WP7 this was a silent swallow).
  const parseArray = (f: FitbitFile): WireRecord[] => {
    let v: unknown;
    try {
      v = JSON.parse(f.text);
    } catch {
      warnings.push({
        code: "skipped-file",
        message: `${f.name}: not valid JSON — file skipped`,
        context: { file: f.name },
      });
      return [];
    }
    if (!Array.isArray(v)) {
      warnings.push({
        code: "skipped-file",
        message: `${f.name}: expected a JSON array of Takeout entries, got ${v === null ? "null" : typeof v} — file skipped`,
        context: { file: f.name },
      });
      return [];
    }
    return v;
  };

  // Intraday samples accumulate across files, then emit one sampleArray per day at the end.
  const intraday: { steps: Sample[]; heart_rate: Sample[] } = { steps: [], heart_rate: [] };

  for (const f of files) {
    const b = basename(f.name);
    if (/^exercise-\d+\.json$/.test(b)) mapExerciseLog(parseArray(f), ctx, f.name);
    else if (/^steps-\d{4}-\d{2}-\d{2}\.json$/.test(b)) collectSteps(parseArray(f), ctx, intraday.steps);
    else if (/^heart_rate-\d{4}-\d{2}-\d{2}\.json$/.test(b)) collectHeartRate(parseArray(f), ctx, intraday.heart_rate);
    else if (/^sleep-\d{4}-\d{2}-\d{2}\.json$/.test(b)) mapSleepLog(parseArray(f), ctx);
    else if (/^weight-\d{4}-\d{2}-\d{2}\.json$/.test(b)) mapWeightLog(parseArray(f), ctx);
    else if (/^resting_heart_rate-\d{4}-\d{2}-\d{2}\.json$/.test(b)) mapRestingHeartRate(parseArray(f), ctx);
    else {
      // Not a recognized Fitbit Takeout kind — ignored, but no longer silently.
      warnings.push({
        code: "unrecognized-file",
        message: `${f.name}: not a recognized Fitbit Takeout file kind (exercise/steps/heart_rate/sleep/weight/resting_heart_rate) — ignored`,
        context: { file: f.name },
      });
    }
    flushSkippedEntries(f.name);
  }

  emitDaySeries(ctx, "steps", intraday.steps);
  emitDaySeries(ctx, "heart_rate", intraday.heart_rate);
  return { records, warnings };
}
