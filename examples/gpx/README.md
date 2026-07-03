# Format-level breadth: GPX (GPS Exchange Format) → OpenBody

`map-gpx.ts` maps three GPX fixtures into OpenBody, validates the wire records against
the JSON Schema, and normalizes them:

| Fixture | Shape it exercises |
|---|---|
| `gpx-sample.gpx` | A timed two-segment track with Garmin `TrackPointExtension` HR/cadence — the happy path: one multi-channel lat/lon/alt location Measurement + separate HR/cadence Measurements, all linked from the Session via `measuredBy` |
| `gpx-no-time-sample.gpx` | A track with **no `<time>`** on any point (route-planning tools like Komoot/AllTrails "download route as GPX" export this shape) — no `sampleArray` offsets are representable (§4.3), so the mapper emits a Session only, with the raw geometry preserved losslessly in `extension.gpx.untimedTrack` |
| `gpx-waypoints-sample.gpx` | A waypoint-only GPX 1.0 file (no `<trk>` at all) — waypoints are map annotations, not observations of a subject, so the mapper returns an empty result |

All three fixtures are hand-built against the official GPX 1.1 XSD (and, for the
waypoint file, GPX 1.0) and Garmin's `TrackPointExtension` XSD — **synthetic, not real
platform exports; verify against real Runkeeper/Komoot/AllTrails/Ride with GPS/Garmin
exports before relying on this in production (OB-79 acceptance)**.

Run: `npx tsx examples/gpx/map-gpx.ts`

## GPX element → OpenBody mapping

| GPX element | OpenBody |
|---|---|
| all `<trk>`/`<trkseg>` in the file | concatenated into **one** Session + one multi-channel location `sampleArray` Measurement (segments mark GPS dropouts/pauses within a single recording, not separate activities) |
| `<trkpt lat lon>` + `<ele>` | `sampleArray` channels `lat`/`lon`/`alt` (deg/deg/m); a missing `<ele>` null-pads the `alt` channel rather than dropping the point |
| `<trkpt><time>` | `sampleArray` offsets (seconds from the first timed point); points with no `<time>` are dropped from the streams and counted in a `dropped-untimed-points` warning |
| Garmin `TrackPointExtension` `<hr>`/`<cad>`/`<power>` | separate single-channel `heart_rate`/`cadence`/`power` Measurements, sharing the location offsets, linked via `measuredBy` |
| `<trk><type>` | `Session.disciplines` (small token map — running/cycling/hiking/walking/swimming/rowing; unknown types round-trip namespaced as `gpx:<type>`) |
| `<trk><name>` | `Session.name` |
| `<gpx creator="…">` | `extension.gpx.creator` (free-form vendor text, not a registry token) |

## Findings

1. **No first-class encoding for untimed tracks.** A drawn-not-recorded route has no
   timestamps to hang a `sampleArray` off — the mapper degrades honestly to a
   Session-only record with the geometry as residue, rather than fabricating offsets.
2. **Waypoint/route-only files are out of scope, not an error.** They're map
   annotations/plans, not observations of a subject — the mapper returns `[]`
   gracefully (with a `no-mappable-content` warning), not a thrown error.
3. **GPX 1.0 parses identically to 1.1.** The shared regex-XML parser (`src/mappers/xml.ts`)
   never inspects namespaces, so the only difference between the two versions (the
   `xmlns` value) is invisible to the mapper.
