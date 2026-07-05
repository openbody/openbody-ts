---
"@openbody/openbody-ts": minor
---

Add `mapHevyMeasurements`: maps Hevy's `measurement_data.csv` body-metric export to point-in-time OpenBody Pillar-A Measurement records. Weight and body-fat map to canonical `body_mass`/`body_fat_percentage`; body circumferences map to the SIDE-AGNOSTIC canonical `anthropometry` registry tokens (`neck_circumference`, `bicep_circumference`, …) with a limb's side carried on the new `Measurement.laterality` field (§4.1, `left｜right｜bilateral`) derived from the column's `left_`/`right_` prefix — not baked into the type token. Circumference length unit follows the user's Hevy setting via the column suffix (`_in` → `[in_i]`, `_cm` → `cm`) — fixing a bug where metric-unit users' circumferences matched nothing and were silently dropped — while weight is always kg. Unrecognized header columns raise a one-time `unrecognized-column` warning so future Hevy format drift surfaces instead of dropping silently.
