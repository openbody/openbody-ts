# Real-data dogfooding

Mapping **real export formats** into OpenBody, then validating each wire record against
the JSON Schema and normalizing it (§8.3). This is how we find model gaps before going
public — and a seed for the eventual mapper SDKs (launch Phase D).

| Source | Pillar | Result |
|---|---|---|
| [`hevy/`](./hevy/) | B (strength) | Real Hevy CSV → Session/Exercise/WorkUnit. Validates + normalizes. |
| [`strong/`](./strong/) | B (strength) | Strong CSV (documented columns) → same shape. Validates + normalizes. |
| [`strava/`](./strava/) | A + B | Activity + streams → sampleArray Measurements + Session w/ `measuredBy`. Validates + normalizes. |

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
