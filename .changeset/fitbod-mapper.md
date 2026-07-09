---
"@openbody/openbody-ts": minor
---

feat(mappers): add Fitbod CSV mapper (`mapFitbod`). Maps a Fitbod workout export (one
row per set) to OpenBody Sessions/Exercises/WorkUnits — sessions inferred from a >3h gap
between set timestamps, reps/weight/duration/distance scoring (distance+time → `continuous`
per §5.5), and Fitbod-only fields (warmup/incline/resistance/multiplier) preserved
losslessly in a `com.fitbod.export` extension. Fixture is synthetic — real-export
verification tracked in OB-82.
