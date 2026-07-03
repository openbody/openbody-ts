# openbody-ts

The **TypeScript reference implementation** of the [OpenBody](https://github.com/openbody/openbody)
standard — validate, canonically normalize (the conformance suite's EQUIVALENCE.md method), and check equivalence of OpenBody
records, plus a conformance-vector runner.

> Status: early (v0.1.0), tracks the **current pre-v1.0 OpenBody draft** (see the standard's
> `CHANGELOG.md`). A reference implementation is *one* implementation, not normative —
> `SPEC.md` is the source of truth.
> **Licensed Apache-2.0** (the standard itself is OWFa-1.0; kept in a separate repo).

## What it does

- **`validate(record)`** — validates against the published JSON Schema (§§4–7).
- **`normalizeDocument(doc)`** — runs the EQUIVALENCE.md canonical-normalization pipeline
  (number → lowest-terms fixed-point, unit canon, scalar→Target expansion, ExerciseRef
  fold, `sets` expansion, deterministic id assignment, flatten + `partOf`, status
  default, RFC 8785 serialization) → a sorted set of canonical record byte strings.
- **`equivalent(a, b)`** — true iff two documents normalize to the same set.
- **`src/mappers/`** — incumbent → OpenBody mappers (Hevy, Strong, Strava, Apple Health,
  FIT; Health Connect via the Apple mapper): pure functions with round-trip tests
  (`test/mappers/`). Plus format-level **GPX + TCX** mappers (`mapGpx`/`mapTcx` —
  covers Runkeeper, Komoot, AllTrails, Ride with GPS, MapMyRun, Garmin/Polar legacy
  exports): trackpoint streams → multi-channel location + HR/cadence/power
  `sampleArray` Measurements, TCX laps → per-lap WorkUnits, all linked via
  `measuredBy` (`test/mappers/{gpx,tcx}.test.ts`; built against the official schemas — verify against
  real platform exports, OB-79). And **Fitbit (Google Takeout)** — `mapFitbitTakeout`
  takes the Takeout folder's JSON files (exercise/steps/heart_rate/sleep/weight/
  resting-heart-rate): Sessions + per-day `sampleArray` series + adjacent sleep-stage
  `category` intervals (short wakes spliced in), exact fixed-point weights
  (`test/mappers/fitbit.test.ts`; built against publicly documented Takeout structure — verify
  with a real Takeout, OB-80). Plus two breadth mappers (`test/mappers/{concept2,thecrag}.test.ts`):
  **Concept2 Logbook** season CSV (RowErg/SkiErg/BikeErg — pieces as
  time/distance/continuous WorkUnits, fixed-interval workouts as Blocks with
  per-interval rest, stroke rate/watts as §5.13 intensity, avg HR as a linked
  Measurement) and **theCrag** climbing logbook CSV (one Session per crag day; each
  ascent a reps-scored WorkUnit with grade modifier and send/attempt `outcome` per
  the canonical §5.18 corpus encoding). Plus one outbound mapper, OpenBody → Strong CSV
  (`mapOpenBodyToStrong`) — the import path into Strong *and* Hevy (which accepts
  Strong-format CSVs). Covers everything Strong's CSV can hold: reps ± weight,
  bodyweight, duration and distance sets, RPE, notes — with non-kg/m/s units converted
  by exact decimal math. Anything Strong can't represent (supersets/round schemes,
  %1RM loads, energy scoring, …) degrades gracefully per the documented policy and is
  reported in the returned `{ csv, omissions }` (SPEC §10: emitting into a
  less-expressive target is best-effort, bounded by the target); pass
  `{ strict: true }` to throw instead. See `src/mappers/to-strong.ts` for the full
  policy.
- **`resolveExerciseRef(name, { source })`** — the §6.5 producer-side matching ladder:
  raw app exercise names → canonical registry ids, with the original string preserved
  losslessly (see "Exercise-name resolution" below). Wired into the Hevy/Strong mappers.

This is the artifact that makes the conformance vectors *executable*: it pins the
canonical bytes the spec describes.

## Errors & warnings

One small typed hierarchy (`src/errors.ts`), all exported from the package root:
`OpenBodyError` (base, with a machine-readable `code`) and its three subclasses
`MapperInputError`, `NormalizeError`, `ParseError`. The per-layer policy:

- **`validate`** reports invalid documents via its result object (`{ valid, errors }`)
  — it never throws on an invalid doc.
- **`parseLossless`** throws `ParseError` on malformed JSON text (carries the failure
  character `offset`).
- **`normalizeDocument`/`equivalent`** throw `NormalizeError` on structurally
  malformed records (invalid `roundScheme`/`sets` combinations, non-numeric
  fixed-point parts).
- **Inbound mappers** return a `MapperResult` — `{ records, warnings }`. They throw
  `MapperInputError` only when the input is *structurally unusable* (wrong file
  shape, missing required column/stream), and **never** on merely-missing optional
  data: that degrades and is reported on the warnings channel instead
  (`MapWarning { code, message, context? }` — e.g. `default-subject` when no
  `subject` option was passed, `skipped-file` for a corrupt Takeout file,
  `dropped-untimed-points` for untimed GPX/TCX points).
- **The outbound Strong mapper** keeps its established contract: best-effort
  `{ csv, omissions }`, throwing only under `{ strict: true }`.

```ts
import { mapHevy, MapperInputError } from "@openbody/openbody-ts";

try {
  const { records, warnings } = mapHevy(csvText, { subject: "athlete-1" });
  for (const w of warnings) console.warn(`${w.code}: ${w.message}`);
} catch (e) {
  if (e instanceof MapperInputError) console.error(`not a usable export: ${e.message}`);
  else throw e;
}
```

## Install (as a dependency)

Not yet published to npm (`OB-11` — packaging is ready; publish itself is a
deliberate, separate action gated on the project's go-public timing). **Until then,
install from a git checkout** — pack a tarball and install that (the `prepack` hook
vendors the schema + crosswalk snapshots and builds `dist/` automatically):

```bash
# side-by-side checkouts (the pack step reads the schema + registry from the siblings):
git clone https://github.com/openbody/openbody.git
git clone https://github.com/openbody/openbody-registry.git
git clone https://github.com/openbody/openbody-ts.git
(cd openbody-ts && npm ci && npm pack)          # → openbody-openbody-ts-<version>.tgz
npm install ./openbody-ts/openbody-openbody-ts-*.tgz   # in your project
```

A plain `npm install git+https://github.com/openbody/openbody-ts.git` does **not**
work yet: the vendored data snapshots (`vendor/`) are deliberately gitignored and a
git install can't see the sibling repos to regenerate them.

Once published: `npm install @openbody/openbody-ts`, then `import { validate, normalizeDocument, equivalent } from "@openbody/openbody-ts"`.

The published package **vendors a schema snapshot** (`vendor/openbody.schema.json`,
refreshed from the sibling `openbody` repo by `npm run sync-schema`, which runs
automatically pre-pack/publish) — it does not depend on a sibling checkout at
runtime. `npm run build` compiles `src/` to `dist/` (ESM + `.d.ts`); `npm pack
--dry-run` shows exactly what ships (`dist/`, `vendor/`, `README.md`, `LICENSE`).

## Develop this repo

```bash
npm install
npm run sync-schema     # vendor the schema snapshot from ../openbody (typecheck needs it)
npm run sync-crosswalk  # vendor the exercise-name data from ../openbody-registry (ditto)
npm test           # typecheck + biome lint + the vitest suite (test/: lossless, vectors, resolver, mappers, validate)
# …or individually:
npm run vectors    # run the standard's conformance vectors against this impl (CLI wrapper)
npx vitest run test/mappers      # just the mapper suites
npm run coverage   # vitest with v8 coverage (thresholds enforced on src/)
npm run typecheck
npm run lint       # biome check (lint + format verification; config in biome.jsonc)
npm run format     # biome format --write
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

## Exercise-name resolution (SPEC §6.5)

Exercise identity is the interop problem OpenBody exists to solve: Hevy calls it
"Bench Press (Barbell)", Strong "Barbell Bench Press" — `resolveExerciseRef` turns both
into the same canonical registry id, without ever losing the original string:

```ts
import { resolveExerciseRef } from "@openbody/openbody-ts";

resolveExerciseRef("Bench Press (Barbell)", { source: "hevy" });
// → { id: "bench-press.barbell.flat", opaque: "Bench Press (Barbell)" }
resolveExerciseRef("Some Custom Movement", { source: "hevy" });
// → { opaque: "Some Custom Movement" }   (lossless fallback — never dropped)
```

The ladder is deterministic, climbing the strictest rung that matches:

1. **Exact alias** — the app's exact name in its curated alias table
   (`openbody-registry/crosswalk/<source>.json`). A curated `null` there means "known
   unmappable" and is authoritative: resolution stops and falls back to opaque (no fuzzy
   rung may override the curator).
2. **Canonical-id passthrough** — the name already *is* a registry id.
3. **Normalized match** — lowercase / punctuation-stripped / whitespace-collapsed lookup
   against all alias tables and the registry's id + name index, tried in two
   deterministic forms: as-is, then token-sorted (word-order agnostic). There is
   deliberately **no** discard-the-parenthetical rung — a qualifier like "(Assisted)" is
   semantically load-bearing, and dropping it would mint a false canonical id (the
   near-miss mapping the crosswalk curation rule forbids); uncurated qualified names
   stay opaque until an alias-table entry is curated. A normalized key claimed by two
   different canonical ids is ambiguous and never matches.
4. **Opaque fallback** — `{ opaque: name }`, per §6.1/§6.5 ("couldn't resolve" never
   means "drop").

Resolved refs carry **both** `id` (the interop anchor) and `opaque` (the original app
string, byte-for-byte) — the schema's `ExerciseRef` permits co-presence, and it's what
lets the outbound Strong mapper re-emit the source app's own names on round-trip
(`sourceNameForId` is the reverse lookup). The Hevy and Strong mappers call the
resolver automatically.

**Maintaining the alias tables**: they live in the registry repo
(`openbody-registry/crosswalk/hevy.json` / `strong.json`) — one `{ name, canonical }`
entry per app exercise name, `canonical: null` for movements the registry doesn't
cover yet (do *not* map to a near-miss id; null is correct until the registry grows the
entry, and `openbody-registry`'s `npm run check` verifies every non-null target
resolves). After editing them, re-run `npm run sync-crosswalk` here to refresh the
vendored snapshot (`vendor/crosswalk.json`, gitignored — same pattern as the schema;
default sibling path `../openbody-registry`, override with `OPENBODY_REGISTRY`).

## Number parsing (EQUIVALENCE.md step 1)

JSON numbers are parsed **losslessly** from their decimal text (`parseLossless` →
`LosslessNumber`), never via `float64`, before fixed-point canonicalization — so
high-precision decimals and integers above 2^53 canonicalize to their exact value
(`test/parse.test.ts`/`test/canonical.test.ts` prove it). Feed documents through `parseLossless` (or raw text)
for full EQUIVALENCE.md fidelity; passing a value pre-parsed with `JSON.parse` falls back to the
lossy float64 path.

## Known limitations (first cut)

- No CLI yet — the library surface (validate + normalize + runner + mappers) comes first.

## Layout

| Path | Role |
|---|---|
| `src/canonical.ts` | number/timestamp canon + RFC 8785 serialization + set-array ordering |
| `src/normalize.ts` | the EQUIVALENCE.md normalization / equivalence algorithm (the suite's oracle) |
| `src/validate.ts` | JSON Schema validation (ajv), browser-safe — validates against the vendored schema, no `node:*` imports |
| `src/schema-loader-node.ts` | Node-only: `OPENBODY_STANDARD`-aware schema resolution + `standardDir`, used by dev/test scripts; not exported from `src/index.ts` |
| `src/parse.ts` | lossless decimal JSON parse (`parseLossless` / `LosslessNumber`) |
| `src/errors.ts` | the typed error hierarchy (`OpenBodyError` / `MapperInputError` / `NormalizeError` / `ParseError`) + the per-layer error policy |
| `src/resolve.ts` | §6.5 exercise-name resolver (`resolveExerciseRef` / `sourceNameForId`), browser-safe — static import of the vendored crosswalk snapshot |
| `src/mappers/` | incumbent → OpenBody mappers (Hevy/Strong/Strava/Apple/FIT) + index; `to-strong.ts` is the reverse (OpenBody → Strong CSV) mapper |
| `scripts/run-vectors.ts` | conformance-vector runner |
| `scripts/sync-schema.mjs` | copies the schema from the sibling `openbody` repo into `vendor/` for publishing |
| `scripts/sync-crosswalk.mjs` | builds `vendor/crosswalk.json` (registry name index + per-app alias tables) from the sibling `openbody-registry` repo |
| `vendor/` | gitignored; populated by `sync-schema` + `sync-crosswalk`, shipped in the published package |
