// Exercise-name resolution: raw app exercise names → canonical OpenBody registry ids
// (SPEC §6). This is the producer-side half of the §6.5 matching ladder — mappers call
// `resolveExerciseRef` instead of hard-coding `{ opaque }`, so Hevy's "Bench Press
// (Barbell)" and Strong's "Barbell Bench Press" both come out as the same canonical id.
//
// Deterministic ladder (documented in README "Exercise-name resolution"):
//   1. exact match in the per-app alias table (`opts.source`) — a curated `null` there
//      means "known unmappable"; resolution stops and falls back to opaque immediately
//      (the curator's null is authoritative; no fuzzy rung may override it);
//   2. exact canonical-id passthrough (the name already IS a registry id);
//   3. normalized match — lowercase, trim, punctuation stripped, whitespace collapsed —
//      against every alias table AND the bundled registry name index, tried in two
//      deterministic forms:
//        3a. normalized as-is (parenthetical words kept: "bench press barbell"),
//        3b. token-sorted (word order agnostic: Hevy "Bench Press (Barbell)" ↔
//            Strong-style "Barbell Bench Press" both sort to "barbell bench press");
//      there is deliberately NO discard-the-parenthetical rung: a qualifier like
//      "(Assisted)" or "(Smith Machine)" is semantically load-bearing, and dropping it
//      to match the unqualified movement would mint a false canonical id — the exact
//      near-miss mapping the crosswalk curation rule forbids. Unknown qualified names
//      fall through to opaque; the fix is a curated alias-table entry, not a fuzzier match.
//      A normalized key claimed by two different canonical ids is AMBIGUOUS and never
//      matches (deterministic regardless of table order);
//   4. fallback: `{ opaque: name }` — lossless, per §6.1/§6.5 ("couldn't resolve" never
//      means "drop").
//
// Resolved refs carry BOTH `id` and `opaque` (the schema's ExerciseRef `anyOf` permits
// co-presence, and §6.1 makes `opaque` the lossless floor): `id` is the interop anchor,
// `opaque` preserves the original source string byte-for-byte so outbound mappers
// (to-strong.ts) can round-trip the app's own name. When the input already equals the
// canonical id, `opaque` would add nothing and is omitted.
//
// Browser-safe: no node:* imports — the alias/name data is a static JSON import of
// vendor/crosswalk.json, a snapshot of the sibling openbody-registry checkout produced
// by `npm run sync-crosswalk` (same pattern as vendor/openbody.schema.json + sync-schema;
// see src/validate.ts's header for why this module graph must stay pure).
import crosswalk from "../vendor/crosswalk.json" with { type: "json" };

/** The §6.1 ExerciseRef object shape this module produces (id and/or opaque). */
export interface ResolvedExerciseRef {
  /** Canonical registry id (SPEC §6.2), present when the name resolved. */
  id?: string;
  /** The original source string, preserved losslessly (SPEC §6.1/§6.5). */
  opaque?: string;
}

export interface ResolveOptions {
  /** Which app's alias table to consult first (e.g. "hevy", "strong"). */
  source?: string;
}

type AliasTable = Record<string, string | null>;
interface CrosswalkData {
  aliases: Record<string, AliasTable>;
  registry: { id: string; names: string[] }[];
}
const data = crosswalk as unknown as CrosswalkData;

// -- normalization ---------------------------------------------------------------
// One algorithm, applied at lookup time to both index keys and query names (the vendored
// data is raw/un-normalized, so index and query can never disagree).

/** Lowercase, punctuation → space (parenthetical words kept), collapse whitespace, trim. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** `norm`, then tokens sorted — word-order-agnostic form. */
function normSorted(s: string): string {
  return norm(s).split(" ").sort().join(" ");
}

// -- lazily-built lookup indexes ---------------------------------------------------
const AMBIGUOUS = Symbol("ambiguous");
type Index = Map<string, string | typeof AMBIGUOUS>;

interface Indexes {
  canonicalIds: Set<string>;
  plain: Index; // norm() keys
  sorted: Index; // normSorted() keys
}

let indexes: Indexes | null = null;

function addKey(index: Index, key: string, id: string): void {
  if (!key) return;
  const existing = index.get(key);
  if (existing === undefined) index.set(key, id);
  else if (existing !== id) index.set(key, AMBIGUOUS); // two distinct ids → never match
}

function add(idx: Indexes, rawKey: string, id: string): void {
  addKey(idx.plain, norm(rawKey), id);
  addKey(idx.sorted, normSorted(rawKey), id);
}

function buildIndexes(): Indexes {
  const idx: Indexes = {
    canonicalIds: new Set(data.registry.map((e) => e.id)),
    plain: new Map(),
    sorted: new Map(),
  };
  // Registry entries: the id itself (dots/hyphens are punctuation → spaces) + every name.
  for (const entry of data.registry) {
    add(idx, entry.id, entry.id);
    for (const n of entry.names) add(idx, n, entry.id);
  }
  // Every app alias table (nulls are curation work-list items, not index keys).
  for (const table of Object.values(data.aliases)) {
    for (const [name, canonical] of Object.entries(table)) {
      if (canonical != null) add(idx, name, canonical);
    }
  }
  return idx;
}

function getIndexes(): Indexes {
  return (indexes ??= buildIndexes());
}

function lookup(index: Index, key: string): string | undefined {
  const hit = index.get(key);
  return typeof hit === "string" ? hit : undefined;
}

// -- public API --------------------------------------------------------------------

/**
 * Resolve a raw app exercise name to an ExerciseRef, climbing the §6.5 ladder as far as
 * it deterministically can. Resolved: `{ id, opaque: name }` (canonical + lossless
 * original; `opaque` omitted when the name IS the id). Unresolved: `{ opaque: name }`.
 */
export function resolveExerciseRef(name: string, opts: ResolveOptions = {}): ResolvedExerciseRef {
  const idx = getIndexes();

  // 1. Exact match in the requested app's alias table.
  if (opts.source) {
    const table = data.aliases[opts.source];
    if (table && name in table) {
      const canonical = table[name];
      // Curated null = known unmappable: authoritative, skip the fuzzy rungs.
      return canonical == null ? { opaque: name } : { id: canonical, opaque: name };
    }
  }

  // 2. The name already is a canonical registry id.
  if (idx.canonicalIds.has(name)) return { id: name };

  // 3. Normalized match, strictest form first.
  const id = lookup(idx.plain, norm(name)) ?? lookup(idx.sorted, normSorted(name));
  if (id !== undefined) return id === name ? { id } : { id, opaque: name };

  // 4. Lossless opaque fallback.
  return { opaque: name };
}

/**
 * Reverse lookup for outbound mappers: the app's own name for a canonical id (first
 * alias in the app's table that maps to `id`, in the table's stable curated order).
 * Returns undefined when the app has no alias for that id.
 */
export function sourceNameForId(id: string, source: string): string | undefined {
  const table = data.aliases[source];
  if (!table) return undefined;
  for (const [name, canonical] of Object.entries(table)) {
    if (canonical === id) return name;
  }
  return undefined;
}
