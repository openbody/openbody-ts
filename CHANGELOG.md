# @openbody/openbody-ts

## 0.2.1

### Patch Changes

- ace83e7: docs: fix stale version in the README status line. It read `early (v0.1.0)` while the
  package had moved on, so the npm page showed the wrong version. Drop the hardcoded
  version from the prose entirely — `package.json` is the source of truth — so it can't
  drift again on future bumps.

## 0.2.0

### Minor Changes

- abbfd02: Add `mapHevyMeasurements`: maps Hevy's `measurement_data.csv` body-metric export to point-in-time OpenBody Pillar-A Measurement records. Weight and body-fat map to canonical `body_mass`/`body_fat_percentage`; body circumferences map to the SIDE-AGNOSTIC canonical `anthropometry` registry tokens (`neck_circumference`, `bicep_circumference`, …) with a limb's side carried on the new `Measurement.laterality` field (§4.1, `left｜right｜bilateral`) derived from the column's `left_`/`right_` prefix — not baked into the type token. Circumference length unit follows the user's Hevy setting via the column suffix (`_in` → `[in_i]`, `_cm` → `cm`) — fixing a bug where metric-unit users' circumferences matched nothing and were silently dropped — while weight is always kg. Unrecognized header columns raise a one-time `unrecognized-column` warning so future Hevy format drift surfaces instead of dropping silently.

## 0.1.1

### Patch Changes

- 4ec8dac: Preserve a literal `__proto__` key through normalization. `normalizeDocument` /
  `equivalent` previously dropped a `__proto__` key that sat inside an opaque
  `extension`/`script` subtree — the object-rebuild steps assigned keys with `out[k] = v`,
  which hits `Object.prototype`'s `__proto__` setter instead of creating the key — so two
  documents differing only by such a key normalized as equivalent. All object rebuilds now
  define own properties (`Object.defineProperty`), matching `parseLossless`.

## 0.1.0

Initial release (pre-v1.0; tracks the current OpenBody draft — see the standard's
`CHANGELOG.md`).

- `validate` / `createValidator` — schema + semantic validation (§§4–7).
- `normalizeDocument` / `equivalent` — the EQUIVALENCE.md canonical-normalization method
  (RFC 8785), with lossless-decimal parsing (`parseLossless`).
- Inbound mapper SDK (`src/mappers/`) — Hevy, Strong, Strava, Apple Health, FIT, GPX, TCX,
  Fitbit (Takeout), Concept2, theCrag — plus the outbound OpenBody → Strong CSV mapper.
- `resolveExerciseRef` — the §6.5 producer-side exercise-name matching ladder.
- Conformance-vector runner (`npm run vectors`).
