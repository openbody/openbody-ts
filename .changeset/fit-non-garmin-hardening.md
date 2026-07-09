---
"@openbody/openbody-ts": minor
---

Harden `mapFit` against documented non-Garmin device quirks (OB-83): tolerantly normalize numeric fields a lenient decoder wraps in an array or `{ value }` object (COROS's field-size spec violation, python-fitparse#116), capture **every** lap into a per-lap WorkUnit instead of dropping the per-lap breakdown (guarding the first-lap-only defect reported for some Suunto exports), and degrade gracefully on sparse decodes with missing optional fields (Polar). Lap-less activities are unchanged. Fixtures are SYNTHETIC reproductions of each defect's shape; real-device-file verification (COROS + Suunto + Zwift exports) remains as a follow-up acceptance step.
