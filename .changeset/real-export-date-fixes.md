---
"@openbody/openbody-ts": patch
---

fix(mappers): handle real-export date/duration quirks found by verifying against real files.
`toRfc3339` now parses a trailing offset (e.g. Fitbod's `"2022-10-25 11:00:00 +0000"`) —
previously it fell through unparsed, so every real Fitbod export produced invalid `startTime`s
(0/N records valid). And Strong's `Duration` is now parsed from human `"1h 43m"` as well as
bare seconds, so `endTime` is computed for real Strong exports instead of dropped. Regression
tests added for both.
