---
"@openbody/openbody-ts": patch
---

Preserve a literal `__proto__` key through normalization. `normalizeDocument` /
`equivalent` previously dropped a `__proto__` key that sat inside an opaque
`extension`/`script` subtree — the object-rebuild steps assigned keys with `out[k] = v`,
which hits `Object.prototype`'s `__proto__` setter instead of creating the key — so two
documents differing only by such a key normalized as equivalent. All object rebuilds now
define own properties (`Object.defineProperty`), matching `parseLossless`.
