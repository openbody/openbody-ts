---
"@openbody/openbody-ts": patch
---

docs: fix stale version in the README status line. It read `early (v0.1.0)` while the
package had moved on, so the npm page showed the wrong version. Drop the hardcoded
version from the prose entirely — `package.json` is the source of truth — so it can't
drift again on future bumps.
