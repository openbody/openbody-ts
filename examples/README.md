# Real-data dogfooding

Mapping **real export formats** into OpenBody, then validating each wire record against
the JSON Schema and normalizing it (§8.3). This is how we find model gaps before going
public.

> **The mapping logic is now the mapper SDK** (`src/mappers/`): `mapHevy`, `mapStrong`,
> `mapStrava`, `mapAppleHealth` — pure `input → records[]` functions, round-trip tested
> (`npm run mappers`: every wire record validates + normalization is idempotent). The
> scripts here are thin runners over those functions. Health Connect is covered by the
> Apple Health mapper (identical mapping).

| Source | Pillar | Result |
|---|---|---|
| [`hevy/`](./hevy/) | B (strength) | Real Hevy CSV → Session/Exercise/WorkUnit. Validates + normalizes. |
| [`strong/`](./strong/) | B (strength) | Strong CSV (documented columns) → same shape. Validates + normalizes. |
| [`strava/`](./strava/) | A + B | Activity + streams → sampleArray Measurements + Session w/ `measuredBy`. Validates + normalizes. |
| [`apple-health/`](./apple-health/) | A + B | `export.xml`: discrete + interval quantity samples, **sleep category** series, `HKWorkout` → Session. Validates + normalizes. |

Run any: `tsx examples/<src>/map-<src>.ts`

## What fit cleanly (no model gaps)

- **Strength (Hevy/Strong):** Session → Exercise → WorkUnit with reps/load/RPE; set
  types → `setRole`; **assisted-machine weight → `Load.basis: "assist"`**; supersets →
  `Block grouping:superset`; time/distance scoring for planks/cardio rows.
- **Telemetry (Strava):** HR/power/cadence streams → single-channel `sampleArray`
  Measurements; lat/lon/alt → one **multi-channel location route**; avg/max HR →
  interval `quantity` aggregates with `derivedFrom`; the Session references all
  telemetry via **`measuredBy`**. The continuous-endurance shape works end to end.
- **Exercise identity:** app exercise names map to `exerciseRef.opaque` (the
  hybrid-identity floor) — lossless now, registry-resolvable later.

## Findings worth acting on

1. **No first-class workout `name`/`label` — RESOLVED in v0.3.** Every app has a
   workout title ("Morning workout", "Push Day") and v0.2 had no interoperable home
   for it (an extension preserves but doesn't interoperate). **v0.3 added optional
   `name` on `Program`/`Session`/`Block` and `notes` on `Session`/`Block`/`Exercise`/
   `WorkUnit`.** The mappers now emit `name` directly. *(The first Hevy mapper silently
   dropped `title` — a real losslessness bug this finding surfaced.)*
2. **`derivedFrom` ⇒ `provenance.algorithm` required (§7.4)** bites mappers: Strava
   doesn't publish its aggregation algorithm, so the mapper supplies a best-effort
   `algorithm.name`. The rule is defensible (derived values should be traceable) but
   incumbents rarely provide it — worth a note in mapping guides.
3. **`at-most-one` Session container (§5.3)** forces a mapper choice: mix of supersets
   + standalone exercises ⇒ emit **all-blocks** (wrap standalones in singleton Blocks).
4. **Validate WIRE records, not the §8.3 canonical form** — the canonical form uses
   string fixed-point + propagated/flattened fields and is a *comparison* artifact, not
   the binding. (See the standard's `schema/README`.)
5. **Pillar A is mature (Apple Health).** Discrete quantity samples (instant + daily
   interval aggregate via `startTime≠endTime`), **sleep stages → multiple `category`
   Measurements over adjacent intervals** (exactly §4.3 — not a `sampleArray`), and lazy
   type tokens (known HK identifiers → canonical `heart_rate`/`step_count`; unmapped →
   `apple:HK…`, §4.4) all map with no gaps. `HKWorkout` → Session + continuous WorkUnit
   carrying distance+energy+time.

## Health Connect parity (not a separate mapper)

Android Health Connect maps the same way and needs no new model features:
`StepsRecord` → interval `quantity` Measurement · `HeartRateRecord.samples` →
`sampleArray` (or discrete quantity) · `SleepSessionRecord` stages → `category`
Measurements (like Apple) · `ExerciseSessionRecord` (+ laps/segments/route) → `Session`
(→ Blocks/Exercise; route → `sampleArray` location). Its `title` → the v0.3 `name`.
