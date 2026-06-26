# openbody-ts

The **TypeScript reference implementation** of the [OpenBody](https://github.com/openbody/openbody)
standard — validate, canonically normalize (§8.3), and check equivalence of OpenBody
records, plus a conformance-vector runner.

> Status: early (v0.1.0), tracks OpenBody spec **v0.2.1**. A reference implementation
> is *one* implementation, not normative — `SPEC.md` is the source of truth.
> **Licensed Apache-2.0** (the standard itself is OWFa-1.0; kept in a separate repo).

## What it does

- **`validate(record)`** — validates against the published JSON Schema (§§4–7).
- **`normalizeDocument(doc)`** — runs the §8.3 canonical-normalization pipeline
  (number → lowest-terms fixed-point, unit canon, scalar→Target expansion, ExerciseRef
  fold, `sets` expansion, deterministic id assignment, flatten + `partOf`, status
  default, RFC 8785 serialization) → a sorted set of canonical record byte strings.
- **`equivalent(a, b)`** — true iff two documents normalize to the same set.

This is the artifact that makes the conformance vectors *executable*: it pins the
canonical bytes the spec describes.

## Use

```bash
npm install
npm run vectors    # run the standard's conformance vectors against this impl
npm run typecheck
```

The vector runner and validator read the standard (schema + vectors) from a sibling
checkout (default `../openbody`); override with `OPENBODY_STANDARD=/path/to/openbody`.
When published, the SDK will instead bundle/depend on a versioned schema package.

## Known limitations (first cut)

- **Number parsing.** JSON numbers are read via `JSON.parse` (float64) before
  fixed-point canonicalization, so pathological high-precision decimals could lose
  their exact source text (§8.3 step 1 mandates decimal-text parsing). Typical fitness
  data round-trips exactly; full correctness via a lossless JSON number parser is a TODO.
- Several context/semantic rules the spec assigns to implementations (e.g. `Load.unit`
  conditional, `scoring`↔metric agreement) are not yet validated beyond the schema.
- No mappers/CLI yet — this is the core (validate + normalize + runner) first.

## Layout

| Path | Role |
|---|---|
| `src/canonical.ts` | number/timestamp canon + RFC 8785 serialization + set-array ordering |
| `src/normalize.ts` | the §8.3 normalization / equivalence algorithm |
| `src/validate.ts` | JSON Schema validation (ajv) |
| `scripts/run-vectors.ts` | conformance-vector runner |
