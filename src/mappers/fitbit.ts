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
import { DEFAULT_SUBJECT, type MapOptions, type OpenBodyRecord } from "../types.js";
import { makeDisciplineMapper } from "./shared.js";

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

const parseArray = (text: string): Record<string, any>[] => {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const basename = (name: string) => name.split("/").pop() ?? name;

/** Map any subset of a Google Takeout Fitbit folder ({ name, text } JSON files) to OpenBody wire records. */
export function mapFitbitTakeout(files: FitbitFile[], opts: FitbitMapOptions = {}): OpenBodyRecord[] {
  const subject = opts.subject ?? DEFAULT_SUBJECT;
  const off = opts.utcOffset ?? "Z";
  const records: OpenBodyRecord[] = [];
  const prov = (method: string) => ({ method, sourceApp: "fitbit" });
  // §7.4: derived summaries Fitbit computed on-device/server; version is not published.
  const summaryAlg = (name: string) => ({
    method: "algorithm",
    sourceApp: "fitbit",
    algorithm: { name, version: "takeout" },
  });

  // Intraday per-minute/per-second entries accumulate across files, then emit one
  // sampleArray per calendar day (§4.3) — point-by-point records would not scale.
  type Sample = { e: number; iso: string; v: number };
  const intraday: { steps: Sample[]; heart_rate: Sample[] } = { steps: [], heart_rate: [] };
  const daySeries = (kind: "steps" | "heart_rate", entries: Sample[]) => {
    const tzOff = kind === "heart_rate" ? "Z" : off; // HR is documented UTC; the rest local
    const byDay = new Map<string, typeof entries>();
    for (const en of entries.sort((a, b) => a.e - b.e)) {
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
      records.push({
        id: `fitbit-${kind === "steps" ? "steps" : "hr"}-${day}`,
        recordType: "Measurement",
        subject,
        type: kind === "steps" ? "step_count" : "heart_rate",
        unit: kind === "steps" ? "1" : "/min",
        sampleArray: { offsets: ens.map((x) => (x.e - first.e) / 1000), dataPoints: ens.map((x) => x.v) },
        startTime: first.iso + tzOff,
        endTime: last.iso + tzOff,
        provenance: prov("sensor"),
      });
    }
  };

  for (const f of files) {
    const b = basename(f.name);
    if (/^exercise-\d+\.json$/.test(b)) {
      for (const x of parseArray(f.text)) {
        const startIso = usToIso(String(x.startTime ?? ""));
        if (x.logId == null || !startIso) continue;
        const durMs = Number(x.activeDuration ?? x.duration ?? 0);
        const start = startIso + off,
          end = isoAt(epoch(startIso) + durMs) + off;
        const sid = `fitbit-ex-${x.logId}`;
        const measuredBy: { type: string; ref: string }[] = [];
        if (x.averageHeartRate != null) {
          records.push({
            id: `${sid}-hr-mean`,
            recordType: "Measurement",
            subject,
            type: "heart_rate_mean",
            quantity: x.averageHeartRate,
            unit: "/min",
            startTime: start,
            endTime: end,
            provenance: summaryAlg("fitbit-activity-summary"),
          });
          measuredBy.push({ type: "measuredBy", ref: `${sid}-hr-mean` });
        }
        if (x.steps != null) {
          records.push({
            id: `${sid}-steps`,
            recordType: "Measurement",
            subject,
            type: "step_count",
            quantity: x.steps,
            unit: "1",
            startTime: start,
            endTime: end,
            provenance: prov("sensor"),
          });
          measuredBy.push({ type: "measuredBy", ref: `${sid}-steps` });
        }
        const extra: Record<string, any> = {};
        const perf: Record<string, any> = { time: { absolute: { value: durMs / 1000, unit: "s" } } };
        if (x.distance != null) {
          const unit = DIST_UNIT[x.distanceUnit];
          // Unrecognized distanceUnit: relabeling it km would fabricate data — the raw
          // value+unit pair rides the extension.fitbit residue rail instead.
          if (unit) perf.distance = { absolute: { value: x.distance, unit } };
          else {
            extra.distance = x.distance;
            if (x.distanceUnit != null) extra.distanceUnit = x.distanceUnit;
          }
        }
        if (x.calories != null) perf.energy = { absolute: { value: x.calories, unit: "kcal" } };
        if (Array.isArray(x.heartRateZones) && x.heartRateZones.length) extra.heartRateZones = x.heartRateZones;
        if (Array.isArray(x.activityLevel) && x.activityLevel.length) extra.activityLevel = x.activityLevel;
        if (x.elevationGain != null) extra.elevationGain = x.elevationGain;
        records.push({
          id: sid,
          recordType: "Session",
          subject,
          clientRecordId: String(x.logId),
          disciplines: [disciplineFor(String(x.activityName ?? "unknown"))],
          intent: "train",
          startTime: start,
          endTime: end,
          provenance: prov(x.logType === "manual" ? "manual" : "sensor"),
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
    } else if (/^steps-\d{4}-\d{2}-\d{2}\.json$/.test(b)) {
      for (const x of parseArray(f.text)) {
        const iso = usToIso(String(x.dateTime ?? ""));
        if (iso && x.value != null) intraday.steps.push({ e: epoch(iso), iso, v: Number(x.value) });
      }
    } else if (/^heart_rate-\d{4}-\d{2}-\d{2}\.json$/.test(b)) {
      for (const x of parseArray(f.text)) {
        const iso = usToIso(String(x.dateTime ?? ""));
        if (iso && x.value?.bpm != null) intraday.heart_rate.push({ e: epoch(iso), iso, v: x.value.bpm });
      }
    } else if (/^sleep-\d{4}-\d{2}-\d{2}\.json$/.test(b)) {
      for (const log of parseArray(f.text)) {
        if (log.logId == null || !log.startTime) continue;
        const lid = `fitbit-sleep-${log.logId}`;
        const start = stripFrac(String(log.startTime)) + off;
        const end = log.endTime
          ? stripFrac(String(log.endTime)) + off
          : isoAt(epoch(String(log.startTime)) + Number(log.duration ?? 0)) + off;
        // §4.3: a night of stages = multiple category Measurements over ADJACENT intervals.
        // levels.data is the contiguous timeline; levels.shortData (stages logs only) holds
        // short (≤3 min) wakes that OVERLAP it — physiologically real wakes, so splice them
        // in: punch each short wake out of the underlying stage and insert an awake interval.
        let segs: { s: number; e: number; level: string }[] = (log.levels?.data ?? [])
          .map((d: any) => {
            const s = epoch(String(d.dateTime));
            return { s, e: s + Number(d.seconds) * 1000, level: String(d.level) };
          })
          .filter((g: any) => Number.isFinite(g.s) && g.e > g.s)
          .sort((a: any, b: any) => a.s - b.s);
        for (const sd of log.levels?.shortData ?? []) {
          const s = epoch(String(sd.dateTime)),
            e = s + Number(sd.seconds) * 1000;
          if (!Number.isFinite(s) || e <= s) continue;
          const next: typeof segs = [{ s, e, level: String(sd.level) }];
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
        segs.forEach((g, i) => {
          records.push({
            id: `${lid}-s${i}`,
            recordType: "Measurement",
            subject,
            type: "sleep_stage",
            category: STAGE[g.level] ?? g.level,
            startTime: isoAt(g.s) + off,
            endTime: isoAt(g.e) + off,
            provenance: prov("sensor"),
          });
        });
        // Fitbit-computed summaries → registry sleep duration tokens (quantity over the window).
        if (log.minutesAsleep != null)
          records.push({
            id: `${lid}-duration`,
            recordType: "Measurement",
            subject,
            clientRecordId: String(log.logId),
            type: "sleep_duration",
            quantity: log.minutesAsleep,
            unit: "min",
            startTime: start,
            endTime: end,
            provenance: summaryAlg("fitbit-sleep-summary"),
          });
        const SUMMARY: Record<string, string> = {
          deep: "sleep_deep",
          light: "sleep_light",
          rem: "sleep_rem",
          wake: "sleep_awake",
        };
        for (const [k, type] of Object.entries(SUMMARY)) {
          const mins = log.levels?.summary?.[k]?.minutes;
          if (mins != null)
            records.push({
              id: `${lid}-${k}`,
              recordType: "Measurement",
              subject,
              type,
              quantity: mins,
              unit: "min",
              startTime: start,
              endTime: end,
              provenance: summaryAlg("fitbit-sleep-summary"),
            });
        }
      }
    } else if (/^weight-\d{4}-\d{2}-\d{2}\.json$/.test(b)) {
      for (const x of parseArray(f.text)) {
        const iso = x.date && x.time ? usToIso(`${x.date} ${x.time}`) : undefined;
        if (x.logId == null || !iso || x.weight == null) continue;
        const t = iso + off;
        // Takeout weight is exported in pounds regardless of profile units (community-
        // documented); kept as UCUM [lb_av] rather than converted — lossless per §4.2.
        const aria = typeof x.source === "string" && x.source.toLowerCase() === "aria";
        const p = {
          method: aria ? "sensor" : "manual",
          sourceApp: "fitbit",
          ...(aria ? { device: { manufacturer: "fitbit", model: x.source } } : {}),
        };
        records.push({
          id: `fitbit-weight-${x.logId}`,
          recordType: "Measurement",
          subject,
          clientRecordId: String(x.logId),
          type: "body_mass",
          quantity: fixed(Number(x.weight)),
          unit: "[lb_av]",
          startTime: t,
          endTime: t,
          provenance: p,
        });
        if (x.bmi != null)
          records.push({
            id: `fitbit-weight-${x.logId}-bmi`,
            recordType: "Measurement",
            subject,
            type: "bmi",
            quantity: fixed(Number(x.bmi)),
            unit: "kg/m2",
            startTime: t,
            endTime: t,
            provenance: p,
          });
        if (x.fat != null)
          records.push({
            id: `fitbit-weight-${x.logId}-fat`,
            recordType: "Measurement",
            subject,
            type: "body_fat_percentage",
            quantity: fixed(Number(x.fat)),
            unit: "%",
            startTime: t,
            endTime: t,
            provenance: p,
          });
      }
    } else if (/^resting_heart_rate-\d{4}-\d{2}-\d{2}\.json$/.test(b)) {
      for (const x of parseArray(f.text)) {
        const iso = usToIso(String(x.dateTime ?? ""));
        const v = x.value?.value;
        if (!iso || v == null || v === 0) continue; // days without data export as 0
        const day = iso.slice(0, 10);
        records.push({
          id: `fitbit-rhr-${day}`,
          recordType: "Measurement",
          subject,
          type: "resting_heart_rate",
          quantity: v,
          unit: "/min",
          startTime: `${day}T00:00:00${off}`,
          endTime: isoAt(epoch(`${day}T00:00:00`) + 86400000) + off,
          provenance: prov("estimated"), // Fitbit RHR is a model estimate (the export carries an `error` term)
        });
      }
    }
    // any other file: not a recognized Fitbit Takeout kind — ignored.
  }

  daySeries("steps", intraday.steps);
  daySeries("heart_rate", intraday.heart_rate);
  return records;
}
