# Contributing to openbody-ts

Thanks for your interest. This is the **TypeScript reference implementation** of the
[OpenBody](https://github.com/openbody/openbody) standard (validate + canonical normalize +
conformance-vector runner + incumbent→OpenBody mappers). It's a small, focused, Apache-2.0
library — a reference implementation is *one* implementation, not normative: **`SPEC.md` in
the `openbody` repo is the source of truth**, and this package follows it.

## Ground rules

- **Fidelity matters.** `normalizeDocument`/`equivalent` are the spec's equivalence oracle.
  The public API and the canonical output must not change unless the change is intentional,
  covered by a test, and — if it shifts canonical bytes — pinned by a conformance vector.
- **Every commit is green** (build, typecheck, lint, tests). Keep PRs small and cohesive.

## Prerequisites

- **Node ≥ 20.19** (`.nvmrc` pins it — `nvm use`). npm.

## First-time setup

The schema + exercise-crosswalk data under `vendor/` are **gitignored snapshots** synced
from sibling repos, so clone those side by side, then sync:

```sh
# next to openbody-ts/
git clone https://github.com/openbody/openbody.git
git clone https://github.com/openbody/openbody-registry.git

cd openbody-ts
npm ci
npm run sync-schema      # vendor/openbody.schema.json  (from ../openbody, or $OPENBODY_STANDARD)
npm run sync-crosswalk   # vendor/crosswalk.json        (from ../openbody-registry, or $OPENBODY_REGISTRY)
```

Without the schema snapshot, **typecheck fails** — the package imports it. Registry-backed
test assertions self-skip (with a warning) if the registry checkout isn't present.

## The gate

```sh
npm test            # typecheck (tsc) + lint/format (biome check) + vitest run
npm run coverage    # v8 coverage — must not regress (thresholds in vitest.config.ts)
npm run vectors     # run against the standard's conformance vectors
npm run format      # apply biome formatting
```

A **pre-commit hook** auto-formats staged files (biome via lint-staged). CI
(`.github/workflows/conformance.yml`) runs the full gate on Node 20.19 / 22 / 24.

## Conventions — enforced, not restated

There's little to memorize because the conventions live in tooling:

- **`tsconfig.json`** — `strict`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`
  (so `import type` for type-only imports is mandatory), among others.
- **`biome.jsonc`** — lint + format, plus a max-function-length ceiling
  (`noExcessiveLinesPerFunction`, scoped to `src/`).

In prose: **named exports** (no default exports); **parse/validate at boundaries** instead
of casting (`as`, non-null `!`, and `any` are smells — the few deliberate `any`s are fenced
with a `biome-ignore` + reason); **discriminated `recordType` unions**; model absence and
failure in the types (`T | undefined`, the typed error hierarchy in `src/errors.ts`), not
thrown `any`. Tests use Vitest `describe`/`it`, **one behaviour per test**, arrange-act-assert,
intention-revealing names; reuse the helpers in `test/helpers.ts`
(`expectValidAndStable`, `ofKind`, `abs`, …).

## Commits & releases

- **Conventional Commits**: `type(scope): summary` (e.g. `fix(normalize): …`,
  `refactor(fitbit): …`). Small, cohesive commits.
- **Changesets**: for any user-facing change, run `npx changeset` and commit the generated
  file describing the bump (patch/minor/major). Internal-only changes (refactors, tests,
  docs) need none. Maintainers cut releases with `npm run version-packages` (bump +
  regenerate `CHANGELOG.md`) then `npm run release` (publish).

## Adding an inbound mapper

The mappers (`src/mappers/`) are the main contribution surface. Each is a **pure function**
`mapX(input, opts): MapperResult`. `src/mappers/fit.ts` is a good model. Steps:

1. **`src/mappers/<name>.ts`** exporting `export function mapX(input, opts: MapOptions = {}):
   MapperResult`, returning `{ records, warnings }`.
2. **Reuse the shared plumbing**: `subjectFor`, `makeDisciplineMapper`, `makeScalarStream`,
   `pickSeries` (`shared.ts`); the CSV helpers in `csv.ts`; `resolveExerciseRef` for
   exercise-name → canonical-id resolution.
3. **Error policy** (see the header of `src/errors.ts`): throw `MapperInputError` **only**
   when the input is structurally unusable (wrong file shape, missing required
   column/stream). **Never** throw on merely-missing optional data — degrade and report it
   on the `warnings` channel (`MapWarning`). Never fabricate: data with no honest core home
   rides `extension.<vendor>` residue.
4. **Document** the mapping decisions + sourcing in a file-header comment (match any existing
   mapper).
5. **Register**: export from `src/mappers/index.ts`, re-export from `src/index.ts`.
6. **Test**: `test/mappers/<name>.test.ts`. Every emitted record must schema-validate **and**
   round-trip — assert with `expectValidAndStable(records)`. Add a fixture under
   `examples/<name>/`.

## Conformance vectors

`npm run vectors` runs this implementation against the byte-pinned canonical outputs in the
`openbody` repo (`conformance/vectors`) — they pin the exact normalized bytes the spec
describes. A change to `normalize`/`canonical`/`validate` that shifts canonical bytes will
**fail a vector**; that is the safety net working. If the change is intentional new normative
behaviour, it needs a corresponding new/updated vector in the `openbody` repo — and, since
the SPEC is the source of truth, a spec change first.

## Sign-off (DCO)

All commits must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/) —
add a `Signed-off-by: Name <email>` trailer with `git commit -s`. This certifies you have
the right to submit the contribution; a DCO check gates merges (consistent with the
`openbody` standard repo). To sign off existing commits on a branch:
`git rebase --exec 'git commit --amend --no-edit -s' origin/main`.

## Code of Conduct

Please be respectful. Report concerns to **conduct@openbody.dev**.
