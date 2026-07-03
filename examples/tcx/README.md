# Format-level breadth: TCX (Garmin Training Center Database v2) → OpenBody

`map-tcx.ts` maps `tcx-sample.tcx` — one Running `<Activity>` with two `<Lap>`s (the
second an `Intensity: Resting` recovery interval) and Trackpoint streams including
Stryd-style running power via the `ns3:TPX` extension — into OpenBody, validates the
wire records against the JSON Schema, and normalizes them.

The fixture is hand-built against Garmin's official `TrainingCenterDatabasev2` and
`ActivityExtensionv2` XSDs, following the canonical Garmin Connect export shape —
**synthetic, not a real device export; verify against real Garmin/Polar/MapMyRun
exports before relying on this in production (OB-79 acceptance)**.

Run: `npx tsx examples/tcx/map-tcx.ts`

## TCX element → OpenBody mapping

| TCX element | OpenBody |
|---|---|
| one `<Activity>` | one `Session` (`<Id>` → `clientRecordId`; `Sport` attr → `disciplines`, e.g. Running → `running`, Biking → `cycling`, other → `tcx:other`) |
| one `<Lap>` | one `continuous`-scored `WorkUnit` (`TotalTimeSeconds`/`DistanceMeters`/`Calories` → `performance.time`/`distance`/`energy`; `StartTime` attr → `WorkUnit.startTime`) — a lap is a contiguous, atomically-scored slice of one continuous effort, exactly OpenBody's WorkUnit atom, so laps land directly under `Session.workUnits` with no Block/Exercise tier invented |
| `<Lap><Intensity>Resting</Intensity>` | `WorkUnit.setRole: "tcx:resting"` (the `Active` default is not emitted — it adds no information; the core `setRole` vocab has no rest token, so this rides the §5.9 namespaced fallback) |
| `<Lap>` `AverageHeartRateBpm`/`MaximumHeartRateBpm` | per-lap `heart_rate_mean`/`heart_rate_max` interval `quantity` Measurements, `derivedFrom`-linked to the HR stream when one exists |
| `<Trackpoint>` `Position`/`AltitudeMeters`/`HeartRateBpm`/`Cadence`/`ns3:TPX Watts` | `sampleArray` streams (multi-channel lat/lon/alt location, plus single-channel HR/cadence/power), all linked from the Session via `measuredBy` |
| `<Creator><Name>` | `provenance.device.model` (no manufacturer is stated separately, so none is fabricated) |

## Findings

1. **Lap → WorkUnit, not Block.** A TCX lap carries no grouping/repetition semantics
   (§5.4) — it's a single scored effort, so it maps straight to a WorkUnit rather than
   inventing a Block tier the source data doesn't support.
2. **Namespace-prefix tolerance matters for real exports.** Garmin Connect's TCX uses
   `ns3:TPX`/`ns3:Watts`; the shared regex-XML helpers (`src/mappers/xml.ts`) match
   element names regardless of namespace prefix, so this parses the same as an
   unprefixed `<TPX>`.
3. **`<Courses>` and `<Workouts>` are documented unsupported.** They're planned
   routes/step prescriptions, not a performed or prescribed OpenBody Session shape
   TCX's own `<Activity>` covers — a file containing only those maps to `[]` gracefully
   (use `mapFit` for a decoded structured-workout file instead).
