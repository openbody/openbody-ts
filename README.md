# openbody-ts

The **TypeScript reference implementation** of the [OpenBody](https://github.com/openbody/openbody)
standard — validate, canonically normalize (§8.3), and check equivalence of OpenBody
records, plus a conformance-vector runner.

> Status: early (v0.1.0), tracks OpenBody spec **v0.3.x**. A reference implementation
> is *one* implementation, not normative — `SPEC.md` is the source of truth.
> **Licensed Apache-2.0** (the standard itself is OWFa-1.0; kept in a separate repo).

## What it does

- **`validate(record)`** — validates against the published JSON Schema (§§4–7).
- **`normalizeDocument(doc)`** — runs the §8.3 canonical-normalization pipeline
  (number → lowest-terms fixed-point, unit canon, scalar→Target expansion, ExerciseRef
  fold, `sets` expansion, deterministic id assignment, flatten + `partOf`, status
  default, RFC 8785 serialization) → a sorted set of canonical record byte strings.
- **`equivalent(a, b)`** — true iff two documents normalize to the same set.
- **`src/mappers/`** — incumbent → OpenBody mappers (Hevy, Strong, Strava, Apple Health;
  Health Connect via the Apple mapper): pure functions with round-trip tests (`npm run mappers`).

This is the artifact that makes the conformance vectors *executable*: it pins the
canonical bytes the spec describes.

## Use

```bash
npm install
npm test           # typecheck + lossless number checks + vectors + mapper round-trips
# …or individually:
npm run vectors    # run the standard's conformance vectors against this impl
npm run mappers    # incumbent mappers (Hevy/Strong/Strava/Apple) round-trip
npm run lossless   # §8.3 lossless-number checks
npm run typecheck
```

The vector runner and validator read the standard (schema + vectors) from a sibling
checkout (default `../openbody`); override with `OPENBODY_STANDARD=/path/to/openbody`.
When published, the SDK will instead bundle/depend on a versioned schema package.

## Number parsing (§8.3 step 1)

JSON numbers are parsed **losslessly** from their decimal text (`parseLossless` →
`LosslessNumber`), never via `float64`, before fixed-point canonicalization — so
high-precision decimals and integers above 2^53 canonicalize to their exact value
(`npm run lossless` proves it). Feed documents through `parseLossless` (or raw text)
for full §8.3 fidelity; passing a value pre-parsed with `JSON.parse` falls back to the
lossy float64 path.

## Known limitations (first cut)

- Several context/semantic rules the spec assigns to implementations (e.g. `Load.unit`
  conditional, `scoring`↔metric agreement) are not yet validated beyond the schema
  (a `validateSemantics()` pass is planned).
- No CLI yet — the library surface (validate + normalize + runner + mappers) comes first.

## Layout

| Path | Role |
|---|---|
| `src/canonical.ts` | number/timestamp canon + RFC 8785 serialization + set-array ordering |
| `src/normalize.ts` | the §8.3 normalization / equivalence algorithm |
| `src/validate.ts` | JSON Schema validation (ajv) |
| `src/parse.ts` | lossless decimal JSON parse (`parseLossless` / `LosslessNumber`) |
| `src/mappers/` | incumbent → OpenBody mappers (Hevy/Strong/Strava/Apple) + index |
| `scripts/run-vectors.ts` | conformance-vector runner |
