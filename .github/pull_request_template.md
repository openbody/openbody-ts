<!--
Thanks for contributing to the OpenBody TypeScript reference implementation.
Keep PRs small and cohesive. See CONTRIBUTING.md for the full guide.
-->

## Summary

<!-- What does this change and why? Link any related issue. -->

## Changes

<!-- Bullet the notable changes. -->
-

## Checklist

- [ ] `npm test` passes (typecheck + biome + vitest) and coverage did not regress
- [ ] `npm run vectors` passes (if `normalize`/`canonical`/`validate` or the schema changed)
- [ ] Added a changeset (`npx changeset`) for any user-facing change, or this is internal-only
- [ ] Observable behaviour is unchanged, **or** the change is intentional and covered by a new/updated test and — if it shifts canonical bytes — a conformance vector in the `openbody` repo
- [ ] Commits follow Conventional Commits (`type(scope): summary`)
