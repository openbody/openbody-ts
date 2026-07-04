# @openbody/openbody-ts

## 0.1.1

### Patch Changes

- 4ec8dac: Preserve a literal `__proto__` key through normalization. `normalizeDocument` /
  `equivalent` previously dropped a `__proto__` key that sat inside an opaque
  `extension`/`script` subtree — the object-rebuild steps assigned keys with `out[k] = v`,
  which hits `Object.prototype`'s `__proto__` setter instead of creating the key — so two
  documents differing only by such a key normalized as equivalent. All object rebuilds now
  define own properties (`Object.defineProperty`), matching `parseLossless`.

This changelog is maintained with [Changesets](https://github.com/changesets/changesets).
New entries are generated from the changesets in `.changeset/` when the version is bumped
(`npm run version-packages`); do not edit released sections by hand.

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
