# Dogfooding: real Hevy export → OpenBody

`map-hevy.ts` maps a **real Hevy CSV export** (`hevy-sample.csv`, from
[matanabudy/workout-data-sync](https://github.com/matanabudy/workout-data-sync/blob/main/examples/hevy_export_sample.csv))
into OpenBody, validates the wire record against the JSON Schema, and normalizes it.
This is both a dogfooding test of the model against real data and a seed for an
eventual Hevy mapper (launch Phase D).

Run: `npx tsx examples/hevy/map-hevy.ts`

## Hevy column → OpenBody mapping

| Hevy column | OpenBody |
|---|---|
| `title`, `start_time`/`end_time` | `Session` (+ `startTime`/`endTime`) |
| `exercise_title` | `Exercise.exerciseRef` (currently `{opaque}` — see findings) |
| `superset_id` (non-empty) | a `Block` with `grouping: "superset"` |
| `set_index` | order of `WorkUnit`s within the `Exercise` |
| `set_type` (normal/warmup/drop/failure) | `WorkUnit.setRole` |
| `weight_kg` | `Load.value` (+ `unit: kg`, `basis`) |
| `reps` | `WorkUnit.performance.reps` (scoring `reps`) |
| `distance_km` | `distance` (scoring `distance`) |
| `duration_seconds` | `time` (scoring `time`) |
| `rpe` | `EffortLoad { kind: internal, method: RPE }` |

## Findings (the point of dogfooding)

1. **Clean fit.** A real Hevy workout validates against the schema and normalizes —
   the Pillar B model represents real strength data with no gaps.
2. **Assisted-machine load.** Hevy records assistance weight for "Pull Up (Assisted)"
   as a positive number; OpenBody captures the semantics with `Load.basis: "assist"`
   (vs `marked_weight`). The `basis` design pays off on real data.
3. **Exercise identity via the opaque floor.** Hevy titles ("Leg Press (Machine)")
   carry equipment/variation inline and don't yet resolve to a registry id, so they
   map to `exerciseRef.opaque` — preserved losslessly now, resolvable to canonical ids
   later. Validates the hybrid-identity design on real data.
4. **OpenBody is a superset.** Hevy has no rest/tempo/threshold/planned-vs-performed;
   OpenBody carries them when present (the parity goal).
5. **`at-most-one` container forces a mapper choice.** Hevy can mix supersets and
   standalone exercises in one workout; OpenBody §5.3 allows a Session only one of
   `blocks`/`exercises`/`workUnits`, so the mapper emits **all-blocks** when any
   superset is present (wrapping standalone exercises in singleton Blocks).
6. **Wire form ≠ canonical form (gotcha).** The §8.3 *canonical* form uses
   string-encoded fixed-point numbers and propagates `subject`/`startTime` onto every
   descendant — it is an internal **comparison** representation, **not** the wire
   binding. Validate **wire** records against the JSON Schema; do **not** validate the
   canonical output against it (it deliberately won't pass). (First version of this
   script made exactly that mistake.)
