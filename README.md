# openbody-ts

The **TypeScript reference implementation** of the [OpenBody](https://github.com/openbody/openbody)
standard — validate, canonically normalize (§8.3), and check equivalence of OpenBody
records, plus a conformance-vector runner.

> Status: early (v0.1.0), tracks the **current pre-v1.0 OpenBody draft** (see the standard's
> `CHANGELOG.md`). A reference implementation is *one* implementation, not normative —
> `SPEC.md` is the source of truth.
> **Licensed Apache-2.0** (the standard itself is OWFa-1.0; kept in a separate repo).

## What it does

- **`validate(record)`** — validates against the published JSON Schema (§§4–7).
- **`normalizeDocument(doc)`** — runs the §8.3 canonical-normalization pipeline
  (number → lowest-terms fixed-point, unit canon, scalar→Target expansion, ExerciseRef
  fold, `sets` expansion, deterministic id assignment, flatten + `partOf`, status
  default, RFC 8785 serialization) → a sorted set of canonical record byte strings.
- **`equivalent(a, b)`** — true iff two documents normalize to the same set.
- **`src/mappers/`** — incumbent → OpenBody mappers (Hevy, Strong, Strava, Apple Health,
  FIT; Health Connect via the Apple mapper): pure functions with round-trip tests
  (`npm run mappers`).

This is the artifact that makes the conformance vectors *executable*: it pins the
canonical bytes the spec describes.

## Install (as a dependency)

Not yet published to npm (`OB-11` — packaging is ready; publish itself is a
deliberate, separate action gated on the project's go-public timing). Once
published: `npm install @openbody/openbody-ts`, then `import { validate, normalizeDocument, equivalent } from "@openbody/openbody-ts"`.

The published package **vendors a schema snapshot** (`vendor/openbody.schema.json`,
refreshed from the sibling `openbody` repo by `npm run sync-schema`, which runs
automatically pre-pack/publish) — it does not depend on a sibling checkout at
runtime. `npm run build` compiles `src/` to `dist/` (ESM + `.d.ts`); `npm pack
--dry-run` shows exactly what ships (`dist/`, `vendor/`, `README.md`, `LICENSE`).

## Develop this repo

```bash
npm install
npm test           # typecheck + lossless number checks + vectors + mapper round-trips
# …or individually:
npm run vectors    # run the standard's conformance vectors against this impl
npm run mappers    # incumbent mappers (Hevy/Strong/Strava/Apple/FIT) round-trip
npm run lossless   # §8.3 lossless-number checks
npm run typecheck
npm run build      # compile src/ -> dist/
```

The vector runner (dev/test-only, not shipped) reads the standard (schema + vectors)
from a sibling checkout (default `../openbody`); override with
`OPENBODY_STANDARD=/path/to/openbody`. Schema *validation* prefers the vendored
snapshot when present (run `npm run sync-schema` to refresh it), falling back to the
sibling-repo path otherwise — so `OPENBODY_STANDARD` also lets you validate against
an unmerged local spec change without re-syncing. This `OPENBODY_STANDARD`-aware
resolution lives in `src/schema-loader-node.ts`, a Node-only module kept separate
from `src/validate.ts` (and never re-exported from `src/index.ts`) so importing the
package's main entry point stays safe to bundle for a browser — see the Layout table.

## Number parsing (§8.3 step 1)

JSON numbers are parsed **losslessly** from their decimal text (`parseLossless` →
`LosslessNumber`), never via `float64`, before fixed-point canonicalization — so
high-precision decimals and integers above 2^53 canonicalize to their exact value
(`npm run lossless` proves it). Feed documents through `parseLossless` (or raw text)
for full §8.3 fidelity; passing a value pre-parsed with `JSON.parse` falls back to the
lossy float64 path.

## Known limitations (first cut)

- No CLI yet — the library surface (validate + normalize + runner + mappers) comes first.

## Layout

| Path | Role |
|---|---|
| `src/canonical.ts` | number/timestamp canon + RFC 8785 serialization + set-array ordering |
| `src/normalize.ts` | the §8.3 normalization / equivalence algorithm |
| `src/validate.ts` | JSON Schema validation (ajv), browser-safe — validates against the vendored schema, no `node:*` imports |
| `src/schema-loader-node.ts` | Node-only: `OPENBODY_STANDARD`-aware schema resolution + `standardDir`, used by dev/test scripts; not exported from `src/index.ts` |
| `src/parse.ts` | lossless decimal JSON parse (`parseLossless` / `LosslessNumber`) |
| `src/mappers/` | incumbent → OpenBody mappers (Hevy/Strong/Strava/Apple/FIT) + index |
| `scripts/run-vectors.ts` | conformance-vector runner |
| `scripts/sync-schema.mjs` | copies the schema from the sibling `openbody` repo into `vendor/` for publishing |
| `vendor/` | gitignored; populated by `sync-schema`, shipped in the published package |
