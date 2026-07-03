// The OpenBody wire format as TypeScript types, hand-written against the vendored
// JSON Schema (vendor/openbody.schema.json, SPEC §§4-7) — one interface per schema
// $def, doc comments carrying the schema's own descriptions and spec-section cites.
// These types mirror what the schema VALIDATES (structure); the context-dependent
// rules listed in the schema's top-of-file disclaimer (Load.unit's conditional
// requirement, scoring↔metric agreement, …) are enforced by `validate`, not here.
//
// Openness is deliberate (§5.9 open-token ladder): registry-backed token fields
// (disciplines, qualities, Measurement.type, setRole, Intensity.dimension, …) are
// plain `string` — namespaced/opaque vendor tokens are first-class wire values, so
// narrowing them to the canon vocab would reject conforming documents. Closed spec
// enums (intent, status, scoring, provenance.method, …) are literal unions.
//
// This file is also the public mapper contract (MapOptions / MapperResult /
// DEFAULT_SUBJECT below): every inbound mapper takes a MapOptions and returns a
// MapperResult ({ records, warnings }), whatever its input.

// ---- scalars (§4.2) -----------------------------------------------------------------------

/**
 * Lossless decimal on the wire: value = coefficient × 10^exponent (§4.2).
 * Distinct from canonical.ts's `FixedPoint` (the §8.3 canonical form with STRING
 * coefficient/exponent) — this is the JSON-integer shape producers put on the wire.
 */
export interface FixedPointObject {
  coefficient: number;
  exponent: number;
}

/** A numeric value on the wire: a JSON number or a fixed-point object (§4.2). */
export type WireNumber = number | FixedPointObject;

/** RFC 3339 timestamp with offset (§4.1). */
export type Timestamp = string;

/**
 * Namespaced extension passthrough, keyed by namespace (reverse-DNS or a registry
 * prefix); each value an arbitrary object (§8.1). Contents are opaque to the spec.
 */
export type Extension = Record<string, Record<string, unknown>>;

// ---- Target / scalar-or-Target (§5.10) ----------------------------------------------------

/** Target `absolute` variant: an exact value, optionally with a nested unit (§5.10). */
export interface AbsoluteTarget {
  absolute: { value: WireNumber; unit?: string };
  extension?: Extension;
}

/** Target `range` variant: an inclusive min–max band (§5.10). */
export interface RangeTarget {
  range: { min: WireNumber; max: WireNumber; unit?: string };
  extension?: Extension;
}

/**
 * Target `relativeToThreshold` variant: relative to a ThresholdProfile entry
 * (§5.10/§5.11). Exactly one of `percent` (single) or `min`+`max` (a relative
 * band / training zone) — enforced by the schema, not this type.
 */
export interface RelativeToThresholdTarget {
  relativeToThreshold: {
    percent?: number;
    min?: number;
    max?: number;
    /** Which threshold kind the value is relative to (e.g. "1RM", "FTP"). */
    of: string;
    /** Optional id of the specific ThresholdProfile record. */
    ref?: string;
  };
  extension?: Extension;
}

/** Target `stopCondition` variant: an event, not a number (e.g. to failure) (§5.10). */
export interface StopConditionTarget {
  stopCondition: { kind: string; value?: WireNumber };
  extension?: Extension;
}

/**
 * Target `ramp` variant: directional linear progression from `from` to `to` (§5.10).
 * Order is significant and MUST NOT be normalized/sorted — `from` may be greater than
 * `to` (a descending ramp). Exactly one of `unit` or `of` (with optional `ref`)
 * applies, mirroring the absolute/relativeToThreshold split. Legal only on
 * Load.value/Intensity.value — see {@link TargetWithRamp}.
 */
export interface RampTarget {
  ramp: { from: WireNumber; to: WireNumber; unit?: string; of?: string; ref?: string };
  extension?: Extension;
}

/**
 * Closed one-of, encoded as a single-key object whose key names the variant (§5.10).
 * May additionally carry an `extension` key, ignored for discrimination.
 */
export type Target = AbsoluteTarget | RangeTarget | RelativeToThresholdTarget | StopConditionTarget;

/**
 * Target (§5.10) plus the `ramp` variant. Used only by Load.value and Intensity.value —
 * ramp has no defined meaning on other scalarOrTarget fields.
 */
export type TargetWithRamp = Target | RampTarget;

/** A metric value: a bare scalar (shorthand for `{absolute:{value}}`) or a Target (§5.10). */
export type ScalarOrTarget = WireNumber | Target;

/** A metric value including the `ramp` Target variant (§5.10). Only Load.value/Intensity.value. */
export type ScalarOrTargetWithRamp = WireNumber | TargetWithRamp;

// ---- modular field components (§5.12-§5.18) ------------------------------------------------

/**
 * External resistance (§5.12). `unit` is required for a scalar/absolute/range value,
 * omitted for relativeToThreshold/stopCondition (enforced by `validate`, not this type).
 */
export interface Load {
  value: ScalarOrTargetWithRamp;
  unit?: string;
  /** How the stated weight relates to the actual resistance (registry-backed token, §5.12). */
  basis?: string;
}

/** Plural effort measure (§5.13). Exactly one of `value` | `range` (schema-enforced). */
export interface EffortLoad {
  kind: "external" | "internal";
  /** Scale/method token (e.g. "RPE", "RIR") — open registry-backed vocab (§5.13). */
  method: string;
  value?: number;
  range?: { min: number; max: number };
  unit?: string;
  source?: "manual" | "estimated";
}

/**
 * A non-resistance intensity target (§5.13): power/pace/HR/speed/grade, as an absolute
 * value, a relative-to-threshold value or band, or a named zone. Exactly one of
 * `value` or `zone` (schema-enforced).
 */
export interface Intensity {
  /** Open dimension token (power|pace|hr|speed|grade|…, §5.13/§5.9). */
  dimension: string;
  value?: ScalarOrTargetWithRamp;
  zone?: string;
  unit?: string;
  extension?: Extension;
}

/** Declarative advancement rule + optional opaque script (§5.14). */
export interface Progression {
  rule: string;
  params?: Record<string, unknown>;
  /** Opaque (§8): contents carry no spec meaning and are never canonicalized as numbers. */
  script?: Record<string, unknown>;
}

/** One named phase of a phasePattern: ordered named phases; generalizes tempo and breath work (§5.15). */
export interface PhasePatternPhase {
  name: string;
  durationSec?: WireNumber;
  ratio?: WireNumber;
  qualifier?: string;
}

/** Occurrence's concrete realization (§5.16). */
export interface Descriptors {
  equipment?: {
    manufacturer?: string;
    model?: string;
    settings?: Record<string, unknown>;
  };
  resistanceProfile?: "constant" | "variable" | "accommodating";
}

/** One condition in the open, typed modifier list (§5.17). */
export interface Modifier {
  /** Open modifier-type token (e.g. "grade", "incline", §5.17). */
  type: string;
  value?: number | string;
  unit?: string;
}

/** Skill/sport/game result (§5.18). */
export interface Outcome {
  kind: "score" | "points" | "placement" | "success" | "grade";
  value: number | boolean | string;
  unit?: string;
  attempts?: { made?: number; attempted?: number };
  components?: { name: string; value: number; weight?: number }[];
}

/**
 * Per-side sub-structure for a single scored WorkUnit atom performed once per side
 * (§5.5). The primary metric (reps/time/distance/energy) is per side, not split
 * across sides.
 */
export interface Sides {
  count: number;
  restBetween?: ScalarOrTarget;
}

/** Per-rep detail element (§5.7). */
export interface Rep {
  velocity?: ScalarOrTarget;
  rangeOfMotion?: ScalarOrTarget;
  phasePattern?: PhasePatternPhase[];
  outcome?: Outcome;
}

// ---- prescription / performance (§5.5) ------------------------------------------------------

/**
 * The modular fields shared by prescription and performance (§5.5). Not a schema $def
 * of its own — the schema spells the two shapes out; this base keeps them in lockstep.
 */
export interface ModularFields {
  reps?: ScalarOrTarget;
  time?: ScalarOrTarget;
  distance?: ScalarOrTarget;
  energy?: ScalarOrTarget;
  load?: Load;
  effortLoad?: EffortLoad[];
  intensity?: Intensity[];
  rest?: ScalarOrTarget;
  sides?: Sides;
  phasePattern?: PhasePatternPhase[];
  modifiers?: Modifier[];
}

/** Planned modular fields (§5.5). `sets` is planned-only shorthand. */
export interface Prescription extends ModularFields {
  progression?: Progression;
  /** Expands to N WorkUnits on normalization (§8.3 step 5); mutually exclusive with `performance`. */
  sets?: number;
}

/** Performed modular fields (§5.5): same as prescription minus `sets`, plus `outcome`. */
export interface Performance extends ModularFields {
  outcome?: Outcome;
  /** What ended the effort (open token, §5.5). */
  terminatedBy?: string;
}

// ---- ExerciseRef (§6) ------------------------------------------------------------------------

/** The full movement-reference object (§6.1): canonical id and/or lossless opaque string. */
export interface ExerciseRefObject {
  /** Canonical registry id (§6.2). */
  id?: string;
  registry?: { name?: string; version?: string };
  facets?: Record<string, unknown>;
  coded?: Record<string, unknown>;
  /** The original source string, preserved losslessly (§6.1/§6.5 — the lossless floor). */
  opaque?: string;
  extension?: Extension;
}

/** Movement reference: a bare canonical-id string, or the full object (§6). */
export type ExerciseRef = string | ExerciseRefObject;

// ---- envelope (§7) ---------------------------------------------------------------------------

/** The closed core link relations (§7.2); namespaced strings allowed for extension links. */
export type CoreLinkType =
  | "partOf"
  | "sameActivityAs"
  | "derivedFrom"
  | "peerSensor"
  | "measuredBy"
  | "performedFrom"
  | "groupActivity";

/** A record-to-record relation (§7.2). */
export interface Link {
  /** Closed core relations (§7.2); namespaced strings allowed for extension links. */
  type: CoreLinkType | (string & {});
  /** The target record's id. */
  ref: string;
}

/** A single URL-referenced attachment (§7.6). Reference by URL only — never embedded binary. */
export interface MediaItem {
  /** MUST use the http or https scheme (§7.6); data: and other schemes are disallowed. */
  url: string;
  /** Closed (§7.6). */
  type?: "photo" | "video" | "audio" | "document";
  label?: string;
}

/** How a record's data came to be (§7.4). */
export interface Provenance {
  method?: "manual" | "sensor" | "estimated" | "algorithm";
  device?: { manufacturer?: string; model?: string };
  sourceApp?: string;
  /** Required when method is "algorithm" (§7.4 — enforced in code, not the schema). */
  algorithm?: { name: string; version: string };
  confidence?: number;
}

/**
 * Shared envelope fields (§7). Composed into every record kind. `id`+`subject` are
 * required on TOP-LEVEL records while inlined children may inherit them (§7.1/§7.2)
 * — a context-dependent rule, so both stay optional here.
 *
 * `status` deliberately excludes "deleted": on the wire a deleted record MUST be a
 * {@link Tombstone} stripped to id/recordType/status (§7.5), so "deleted" alongside
 * payload fields is invalid — and the omission is what lets `status` discriminate
 * tombstones from live records in {@link OpenBodyRecord}.
 */
export interface Envelope {
  /** Globally-unique, producer-assigned, stable. MUST NOT contain '#' (reserved for normalization-assigned ids, §8.3). */
  id?: string;
  recordType: string;
  subject?: string;
  /** The record's identifier in the source system (§7.1: round-trip + within-source dedup). */
  clientRecordId?: string;
  links?: Link[];
  provenance?: Provenance;
  status?: "active" | "superseded";
  supersedes?: string;
  revision?: number;
  extension?: Extension;
  /** URL-referenced attachments (§7.6); per-node, not inherited by nested children. */
  media?: MediaItem[];
}

/**
 * A deletion tombstone (§7.5): stripped to id/recordType/status only; exempt from all
 * otherwise-required fields (§7.1). `recordType` stays `string` (a tombstone names the
 * kind of the record it deletes), so narrowing an {@link OpenBodyRecord} by
 * `recordType` alone yields `X | Tombstone` — check `status !== "deleted"` first.
 */
export interface Tombstone {
  id: string;
  recordType: string;
  status: "deleted";
}

// ---- record kinds (§4-§5) ---------------------------------------------------------------------

/**
 * A Pillar A observation (§4.1): exactly one of `quantity` (with `unit`), `category`,
 * or `sampleArray` (schema-enforced). MUST carry type, startTime and endTime (§4.1 —
 * context-level rule; the timestamps may be inherited from an enclosing record).
 */
export interface Measurement extends Envelope {
  recordType: "Measurement";
  /** Open registry-backed measurement-type token (§4.1/§4.4). */
  type: string;
  /** UCUM unit; conditionally required by value kind (§4.1). */
  unit?: string;
  startTime?: Timestamp;
  endTime?: Timestamp;
  quantity?: WireNumber;
  category?: string;
  sampleArray?: SampleArray;
}

/** One dataPoints element (§4.3): a scalar sample, or one multi-channel row (null-padded, never dropped). */
export type SampleDataPoint = number | null | (number | null)[];

/** A time series (§4.3). Exactly one of `frequencyHz` | `offsets` (schema-enforced). */
export interface SampleArray {
  frequencyHz?: number;
  /** Seconds from startTime, one per dataPoint. */
  offsets?: number[];
  channels?: { name: string; unit: string }[];
  dataPoints: SampleDataPoint[];
}

/** One named phase of a Program (§5.2). */
export interface ProgramPhase {
  name: string;
  weekStart?: number;
  weekEnd?: number;
  goal?: string;
  /** Session ids — MUST be a disjoint, order-preserving subset of Program.sessions (§5.2, enforced in code). */
  sessions?: string[];
}

/** A reusable training plan (§5.2). `recurrence` and `phases` are mutually exclusive (schema-enforced). */
export interface Program extends Envelope {
  recordType: "Program";
  /** Session record ids — references, never inlined (§5.2). */
  sessions?: string[];
  recurrence?: { rule: string; count?: number };
  iteration?: number;
  progression?: Progression;
  name?: string;
  phases?: ProgramPhase[];
}

/** One participant in a (group) Session (§5.19). */
export interface Participant {
  ref: string;
  subjectType?: "human" | "animal" | "team";
  species?: string;
  breed?: string;
  role?: string;
}

/**
 * One training occurrence (§5.3). At most one of `blocks` | `exercises` | `workUnits`
 * (§5.3 at-most-one container, schema-enforced).
 */
export interface Session extends Envelope {
  recordType: "Session";
  startTime?: Timestamp;
  endTime?: Timestamp;
  /** Open registry-backed discipline tokens (§4.4/§5.9 ladder). */
  disciplines?: string[];
  intent?: "train" | "test" | "compete" | "recover" | "rehab";
  /** Physical quality/qualities this session develops (§5.3, R20) — open registry-backed tokens; orthogonal to disciplines and intent. */
  qualities?: string[];
  participants?: Participant[];
  accumulation?: boolean;
  blocks?: Block[];
  exercises?: Exercise[];
  workUnits?: WorkUnit[];
  name?: string;
  notes?: string;
  outcome?: Outcome;
}

/** Block-level scoring scheme (AMRAP/EMOM/…, §5.4). */
export interface BlockScoring {
  /** Open scheme token (§5.4). */
  scheme: string;
  timeCapSec?: number;
  intervalSec?: number;
  workSec?: number;
  restSec?: number;
  rounds?: number;
}

/** Block-level performed result (§5.4). */
export interface BlockPerformance {
  outcome?: Outcome;
  time?: ScalarOrTarget;
  rxStatus?: "rx" | "scaled";
}

/**
 * A structural grouping of work (§5.4): supersets, circuits, rounds. `repetitions`
 * and `roundScheme` are mutually exclusive (schema-enforced).
 */
export interface Block extends Envelope {
  recordType: "Block";
  startTime?: Timestamp;
  endTime?: Timestamp;
  /** Inlined in the nested form; omitted in the flat+partOf form, where children are separate records (§7.2). */
  children?: (Block | Exercise | WorkUnit)[];
  repetitions?: number;
  /** Laddered rounds (§5.4): per-round counts (e.g. [21,15,9]). Planned shorthand; expands on normalization (§8.3 step 5). */
  roundScheme?: number[];
  scoring?: BlockScoring;
  /** Open grouping token (superset|circuit|…, §5.4). */
  grouping?: string;
  /** Physical quality/qualities this block develops (§5.4, R20) — same open vocabulary as Session.qualities. */
  qualities?: string[];
  performance?: BlockPerformance;
  rxStatus?: "rx" | "scaled";
  synchronized?: boolean;
  name?: string;
  notes?: string;
}

/** A movement occurrence grouping its WorkUnits (§5.5/§6). */
export interface Exercise extends Envelope {
  recordType: "Exercise";
  exerciseRef: ExerciseRef;
  descriptors?: Descriptors;
  /** Inlined in the nested form; omitted in the flat+partOf form (§7.2). */
  workUnits?: WorkUnit[];
  notes?: string;
}

/**
 * The atomic unit of scored work (§5.5). `exerciseRef` is mutually exclusive with an
 * enclosing Exercise's (§5.5, enforced in code); a metric field contradicting
 * `scoring` is invalid (§5.5, enforced in code).
 */
export interface WorkUnit extends Envelope {
  recordType: "WorkUnit";
  /** What this unit is scored by (§5.8): its primary metric kind. Closed. */
  scoring: "reps" | "time" | "distance" | "continuous" | "energy";
  exerciseRef?: ExerciseRef;
  prescription?: Prescription;
  performance?: Performance;
  /** Open registry-backed set-role token (working|warmup|drop|…, §5.5/§5.9). */
  setRole?: string;
  rxStatus?: "rx" | "scaled";
  /** Participant ref: who performed this unit in a group Session (§5.19). */
  by?: string;
  synchronized?: boolean;
  /** Per-rep detail (§5.7); length MUST equal reps × sides.count when sides is present (context rule). */
  repDetail?: Rep[];
  startTime?: Timestamp;
  endTime?: Timestamp;
  notes?: string;
}

/** One threshold entry (§5.11). `estimationFormula`/`estimatedFrom` are invalid with `source: "tested"` (enforced in code). */
export interface ThresholdProfileEntry {
  /** Open threshold-kind token (1RM|FTP|LTHR|…, §5.11). */
  kind: string;
  value: number;
  unit: string;
  /** What the threshold is for (e.g. an exercise id or intensity dimension, §5.11). */
  for?: string;
  asOf?: Timestamp;
  source?: "tested" | "estimated";
  confidence?: number;
  estimationFormula?: string;
  estimatedFrom?: { reps: number; load: Load };
}

/** A subject's reference-capacity snapshot (§5.11): the thresholds relative Targets resolve against. */
export interface ThresholdProfile extends Envelope {
  recordType: "ThresholdProfile";
  entries: ThresholdProfileEntry[];
}

/** A time-bounded subject status (illness/injury/travel/…, §5.20). */
export interface StatusPeriod extends Envelope {
  recordType: "StatusPeriod";
  /** Open status-type token (§5.20). */
  type: string;
  from: Timestamp;
  to?: Timestamp;
  note?: string;
}

// ---- the record union + escape hatch --------------------------------------------------------

/**
 * A live (non-tombstone) record — the eight payload kinds, discriminated cleanly by
 * `recordType`. This is what every mapper returns: mappers translate exports, which
 * never contain deletions, so typing their output {@link OpenBodyRecord} would force
 * dead tombstone-narrowing on every consumer.
 */
export type LiveRecord =
  | Measurement
  | Program
  | Session
  | Block
  | Exercise
  | WorkUnit
  | ThresholdProfile
  | StatusPeriod;

/**
 * Any addressable OpenBody record on the wire (§4-§5, §7.5) — a {@link LiveRecord} or
 * a deletion {@link Tombstone}. Because a Tombstone's recordType is any string,
 * narrowing by `recordType` alone yields `X | Tombstone`; narrow `status !== "deleted"`
 * first (or instead) to eliminate the tombstone arm. For fully dynamic work, use
 * {@link WireRecord}.
 */
export type OpenBodyRecord = LiveRecord | Tombstone;

/**
 * Escape hatch: the pre-WP6 permissive record shape, for consumers doing dynamic/
 * schema-unaware work (arbitrary JSON trees, incremental record-building). Prefer
 * {@link OpenBodyRecord} — this alias gives up all field-level checking.
 */
// biome-ignore lint/suspicious/noExplicitAny: the deliberate, documented dynamic escape hatch — the package's ONE permissive alias, so every other module can stay `any`-free.
export type WireRecord = Record<string, any>;

// ---- mapper contract --------------------------------------------------------------------------

/**
 * The placeholder subject id every mapper stamps when `MapOptions.subject` is absent.
 * The fallback is reported on the warnings channel (`MapWarning` code
 * "default-subject") — callers should pass their own subject id.
 */
export const DEFAULT_SUBJECT = "subj-001";

/** Options shared by every inbound mapper. */
export interface MapOptions {
  /**
   * Subject id every mapped record is stamped with. When omitted, the mapper falls
   * back to {@link DEFAULT_SUBJECT} and reports the fabrication once via a
   * `MapWarning` (code `"default-subject"`) — callers should almost always pass their
   * own subject id.
   */
  subject?: string;
  /**
   * RFC 3339 offset (e.g. "-07:00") stamped onto the source's offset-less local
   * wall-clock timestamps. Default `"Z"`. Only meaningful for mappers whose source
   * format carries no offset of its own (the CSV mappers, `mapFitbitTakeout`); a
   * format whose timestamps already carry an offset or are documented UTC (GPX, TCX,
   * Strava, Apple Health, decoded FIT) ignores this option — see each mapper's own
   * doc comment.
   */
  utcOffset?: string;
}

/**
 * One thing an inbound mapper degraded, skipped, or defaulted while mapping — the
 * warnings channel (WP7). Structurally unusable input throws `MapperInputError`
 * instead (src/errors.ts states the full per-layer policy); warnings cover input the
 * mapper handled but not silently-losslessly: skipped files/rows/entries, residue
 * routed to `extension`, fabricated defaults (e.g. "default-subject").
 */
export interface MapWarning {
  /** Stable machine-readable warning token (kebab-case, e.g. "default-subject", "skipped-file"). */
  code: string;
  /** Human-readable explanation, suitable for surfacing to end users. */
  message: string;
  /** Optional machine-usable context (file name, row index, dropped count, …). */
  context?: Record<string, unknown>;
}

/** What every inbound mapper returns: the mapped wire records plus the warnings channel. */
export interface MapperResult {
  records: LiveRecord[];
  /** Everything degraded/skipped/defaulted during the mapping — empty when the mapping was clean. */
  warnings: MapWarning[];
}
