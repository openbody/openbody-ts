# Fitbit (Google Takeout) samples

**Constructed, not real.** These files reproduce the *publicly documented* structure of a
Google Takeout Fitbit export (`Takeout/Fitbit/Global Export Data/` in current exports;
older exports used per-category folders like `Physical Activity/`). They were hand-built
from the sources cited in `src/mappers/fitbit.ts`'s header (FitOut's importer sources, two
independent parser write-ups, and the Fitbit Web API sleep docs) — **verify against a real
Takeout before trusting field-level details** (OB-80 acceptance).

| File | Documented shape it reproduces |
|---|---|
| `exercise-0.json` | Activity logs, 100 per file (`exercise-0.json`, `exercise-100.json`, …): `logId`, `activityName`, `startTime` `"MM/DD/YY HH:MM:SS"`, `duration`/`activeDuration` (ms), `calories`, `steps`, `distance`+`distanceUnit`, `averageHeartRate`, `heartRateZones[]`, `activityLevel[]`, `logType`. One auto-detected Run + one manual Elliptical (fallback-token + manual-method case). |
| `steps-2024-01-06.json` | Per-minute step buckets: `{ dateTime: "MM/DD/YY HH:MM:SS", value: "<count>" }` (value is a **string**; note the gap at 07:06–07:09 — buckets are not guaranteed contiguous). |
| `heart_rate-2024-01-06.json` | Intraday HR (seconds-level, irregular): `{ dateTime, value: { bpm, confidence } }`. `dateTime` is documented as **UTC** even though files are named by local day. |
| `sleep-2024-01-01.json` | One `type: "stages"` log: `levels.data` contiguous stage timeline (30 s granularity source), `levels.shortData` short wake **overlapping** the deep segment, `levels.summary` per-stage minutes, `minutesAsleep` etc. Timestamps local, no offset. |
| `weight-2024-01-01.json` | Weigh-ins: `logId`, `weight` (**pounds**, community-documented), `bmi`, optional `fat`, `date "MM/DD/YY"` + `time "HH:MM:SS"`, `source` (one Aria scale, one manual/API entry; `175` also exercises integer fixed-point). |
| `resting_heart_rate-2024-01-01.json` | Daily RHR estimate: `{ dateTime "MM/DD/YY 00:00:00", value: { date, value, error } }` — days without data export `value: 0.0` (second entry; the mapper must skip it). |

Run: `npx tsx examples/fitbit/map-fitbit.ts`
