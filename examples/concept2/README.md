# Breadth proof: Concept2 Logbook (rowing) → OpenBody

`map-concept2.ts` maps a Concept2 Logbook **season CSV export**
(`concept2-season-sample.csv`) into OpenBody, validates the wire records against the
JSON Schema, and normalizes them. The sample is **constructed** to the publicly
documented export format — column set verified against a real export published in
[manderly/c2-erg-best](https://github.com/manderly/c2-erg-best/blob/main/public/concept2-season-2024.csv)
and the [Concept2 forum's column list](https://www.c2forum.com/viewtopic.php?t=209780)
— **built against the publicly documented export format; verify with a real export
(OB-81 acceptance)**.

Run: `npx tsx examples/concept2/map-concept2.ts`

## Concept2 column → OpenBody mapping

| Concept2 column | OpenBody |
|---|---|
| one CSV row | one `Session` (`Log ID` → `clientRecordId`, `Description` → `name`, `Comments` → `notes`) |
| `Type` (RowErg/SkiErg/BikeErg…) | `disciplines` (`rowing` / `concept2:skierg` / `cycling`) + `exerciseRef` (`row.erg` / `ski.erg` / opaque) |
| `Work Distance` / `Work Time (Seconds)` | the piece `WorkUnit`'s primary metric — `distance`-scored for a fixed-distance piece, `time`-scored for fixed-time, `continuous` for a "just row" (both metrics + `energy`) |
| `Description` `"8x500m/0:30r"` / `"4x5:00/1:00r"` | a `Block` of per-interval `WorkUnit`s, each with `rest` (the season CSV has **no per-interval rows**; fixed-interval structure is machine-generated in `Description`) |
| `Description` `"v…"` (variable intervals) | single `continuous` `WorkUnit`; rest totals in `extension.concept2` (per-interval actuals need the per-workout API/stroke export) |
| `Stroke Rate/Cadence` | achieved `intensity` `{ dimension: "cadence", unit: "/min" }` (§5.13; vocab alias "stroke rate") on single pieces; `extension.concept2.avgStrokeRate` on interval workouts (whole-workout average) |
| `Avg Watts` | achieved `intensity` `{ dimension: "power", unit: "W" }` (same rule) |
| `Avg Heart Rate` | a `heart_rate_mean` `Measurement` spanning the workout window, linked `measuredBy` from the `Session` |
| `Pace`, `Stroke Count`, `Drag Factor`, `Cal/Hour`, `Total Cal`, rest totals, the complementary work metric | `extension.concept2` (lossless residue) |
