// FIT (Garmin/ANT+ Flexible and Interoperable Data Transfer) → OpenBody wire records.
// Covers both FIT file kinds: a *recorded activity* (session/lap/record messages) → Pillar A
// Measurements + a performed Pillar B Session, and a *structured workout definition*
// (workout/workout_step messages, e.g. a Zwift/TrainingPeaks/Garmin Connect interval workout)
// → a planned Pillar B Session of prescriptions.
//
// Input is the *decoded* message shape (field names/enums as standardized by the FIT SDK
// profile, `mode: "list"`) — this mapper never parses the binary itself. FIT is a binary
// protocol; unlike the CSV/XML/JSON formats the other mappers read directly, no mapper here
// hand-rolls a binary decoder (that's a solved, error-prone problem — message definitions,
// base types, developer fields, compressed timestamps, CRC), and no *correctly-licensed*
// decoder can be bundled as a runtime dependency of this package (Garmin's official
// `@garmin/fitsdk` license forbids redistribution/sublicensing; third-party decoders vary).
// So, exactly like `mapStrava` assumes the caller already has the Strava API's JSON (it
// doesn't fetch Strava itself), `mapFit` assumes the caller already decoded the `.fit` binary
// with a decoder of their choice (e.g. `fit-file-parser`, MIT) and hands over the resulting
// message lists. The mapping value-add — and the actual design work — is entirely in the FIT
// → OpenBody semantic translation below, not in bytes-to-messages decoding.
import { MapperInputError } from "../errors.js";
import type {
  Block,
  Extension,
  Link,
  LiveRecord,
  MapOptions,
  MapperResult,
  MapWarning,
  Performance,
  Prescription,
  Provenance,
  TargetWithRamp,
  WorkUnit,
} from "../types.js";
import { iso, makeDisciplineMapper, makeScalarStream, pickSeries, subjectFor } from "./shared.js";

/**
 * A numeric FIT field. Well-formed decoders hand back a plain `number`, but a *tolerant*
 * decoder faced with COROS's field-size spec violation (see python-fitparse#116: a field
 * whose declared `size` isn't an integer multiple of its base-type size) reads the field
 * as several elements and surfaces the scalar wrapped in a single-element — occasionally
 * pad-suffixed — array (e.g. `heart_rate: [138]` or `[138, 255]`). `num()` below normalizes
 * every shape (plain / array / `{ value }`) back to one scalar, so the public input
 * contract admits both rather than silently mis-reading a COROS export.
 */
type FitNumber = number | number[] | { value: number };

interface DecodedRecord {
  timestamp: string;
  position_lat?: FitNumber;
  position_long?: FitNumber;
  altitude?: FitNumber;
  heart_rate?: FitNumber;
  power?: FitNumber;
  cadence?: FitNumber;
}
interface DecodedLap {
  timestamp: string;
  start_time?: string;
  total_elapsed_time?: FitNumber;
  total_distance?: FitNumber;
  total_calories?: FitNumber;
}
interface DecodedSession {
  start_time: string;
  sport?: string;
  total_elapsed_time?: FitNumber;
  total_distance?: FitNumber;
  total_calories?: FitNumber;
  avg_heart_rate?: FitNumber;
  max_heart_rate?: FitNumber;
  avg_power?: FitNumber;
  max_power?: FitNumber;
}
interface DecodedWorkout {
  wkt_name?: string;
  sport?: string;
  num_valid_steps?: FitNumber;
}
interface DecodedWorkoutStep {
  message_index: { value: number } | number;
  wkt_step_name?: string;
  duration_type?: string;
  duration_value?: FitNumber;
  target_type?: string;
  target_value?: FitNumber;
  custom_target_value_low?: FitNumber;
  custom_target_value_high?: FitNumber;
  intensity?: string;
}
/** The decode shape this mapper expects — matches `fit-file-parser`'s `mode: "list"` output. */
export interface FitInput {
  sessions?: DecodedSession[];
  laps?: DecodedLap[];
  records?: DecodedRecord[];
  workouts?: DecodedWorkout[];
  workout_steps?: DecodedWorkoutStep[];
}

const SPORT: Record<string, string> = {
  running: "running",
  cycling: "cycling",
  swimming: "swimming",
  walking: "walking",
  hiking: "hiking",
  rowing: "rowing",
  training: "strength",
};
const mapSport = makeDisciplineMapper(SPORT, "fit");
const disciplineFor = (sport?: string) => mapSport(sport ?? "generic");

/**
 * Coerce a {@link FitNumber} (or any value a tolerant decoder emitted for a numeric field)
 * to a finite scalar, or `undefined` when the field carried nothing usable. Unwraps the
 * `{ value }` object form and — for the COROS field-size defect — takes the first finite
 * element of an array, ignoring trailing pad/invalid sentinels. Non-finite values (NaN /
 * FIT "invalid") are treated as absent, so downstream `!= null` guards degrade gracefully.
 */
function num(v: unknown): number | undefined {
  if (Array.isArray(v)) {
    for (const el of v) {
      const n = num(el);
      if (n !== undefined) return n;
    }
    return undefined;
  }
  if (v != null && typeof v === "object" && "value" in v) return num((v as { value: unknown }).value);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const indexOf = (mi: DecodedWorkoutStep["message_index"]) => num(typeof mi === "number" ? mi : mi.value) ?? 0;

// §5.13: Intensity.dimension is an open token (power|pace|hr|speed|grade|…) — cadence isn't yet
// enumerated in the spec's worked examples but fits the same open mechanism (§5.9).
const INTENSITY_DIM: Record<string, { dimension: string; unit: string }> = {
  heart_rate: { dimension: "hr", unit: "/min" },
  speed: { dimension: "speed", unit: "m/s" },
  power: { dimension: "power", unit: "W" },
  cadence: { dimension: "cadence", unit: "/min" },
  grade: { dimension: "grade", unit: "%" },
};

// setRole (§5.5) is registry-backed open vocab; FIT's step-level `intensity` is the closest
// analog (a step's *structural* position in the workout) for the two tokens the core vocab
// already names. Anything else round-trips source-namespaced, same pattern as `apple-health.ts`.
const SET_ROLE: Record<string, string> = { active: "working", warmup: "warmup" };
const setRoleFor = (intensity?: string) => (intensity ? (SET_ROLE[intensity] ?? `fit:${intensity}`) : undefined);

// duration_type values that mean "repeat the preceding step range," not a real training step —
// `duration_value` holds the message_index to loop back to, `target_value` the repeat count.
const REPEAT_DURATION = /^repeat_until_/;

function targetValue(step: DecodedWorkoutStep): TargetWithRamp | undefined {
  const low = num(step.custom_target_value_low),
    high = num(step.custom_target_value_high);
  if (low != null && high != null) {
    // SPEC.md's own Zwift crosswalk (Warmup/Cooldown/Ramp → Intensity.value `ramp`) is the
    // precedent: a warmup/cooldown step's target band is directional, not a plain range.
    if (step.intensity === "warmup") return { ramp: { from: low, to: high } };
    if (step.intensity === "cooldown") return { ramp: { from: high, to: low } };
    return { range: { min: low, max: high } };
  }
  const value = num(step.target_value);
  if (value != null) return { absolute: { value } };
  return undefined; // target_type "open" (or no value at all): athlete's choice, no target.
}

function stepToWorkUnit(step: DecodedWorkoutStep, idx: number): WorkUnit {
  const setRole = setRoleFor(step.intensity);

  // WorkUnit.scoring is required (§5.5), so the switch computes scoring/prescription/
  // extension first and the record literal below assembles them — in the same key order
  // the old field-by-field construction produced (id, recordType, setRole?, scoring,
  // extension?, prescription). The FIT profile guarantees a `duration_value` for every
  // value-carrying duration_type, hence the `as number` casts.
  const prescription: Prescription = {};
  let scoring: WorkUnit["scoring"];
  let extension: Extension | undefined;
  // The FIT profile guarantees a `duration_value` for every value-carrying duration_type;
  // `?? 0` is a defensive floor for a truncated/sparse decode that dropped it.
  const durationValue = num(step.duration_value) ?? 0;
  switch (step.duration_type) {
    case "distance":
      scoring = "distance";
      prescription.distance = { absolute: { value: durationValue, unit: "m" } };
      break;
    case "reps":
      scoring = "reps";
      prescription.reps = durationValue;
      break;
    case "calories":
      scoring = "energy";
      prescription.energy = { absolute: { value: durationValue, unit: "kcal" } };
      break;
    case "open":
      scoring = "time";
      prescription.time = { stopCondition: { kind: "open" } };
      break;
    case "time":
      scoring = "time";
      prescription.time = { absolute: { value: durationValue, unit: "s" } };
      break;
    default:
      // Exotic conditional-stop durations (hr_less_than, power_greater_than, …): rare in
      // practice. Canonical-plus-residue (per the mapping guide's principles): degrade to a
      // valid, generically-scored WorkUnit and preserve the raw FIT condition losslessly.
      scoring = "continuous";
      prescription.time = { stopCondition: { kind: "open" } };
      extension = { fit: { duration_type: step.duration_type } };
  }

  const dim = step.target_type && INTENSITY_DIM[step.target_type];
  if (dim) {
    const value = targetValue(step);
    if (value) prescription.intensity = [{ dimension: dim.dimension, unit: dim.unit, value }];
  }
  return {
    id: `fit-wkt-wu-${idx}`,
    recordType: "WorkUnit",
    ...(setRole ? { setRole } : {}),
    scoring,
    ...(extension ? { extension } : {}),
    prescription,
  };
}

function mapWorkout(data: FitInput, subject: string, warnings: MapWarning[]): LiveRecord[] {
  const wkt = data.workouts?.[0];
  if ((data.workouts?.length ?? 0) > 1) {
    warnings.push({
      code: "extra-workouts-dropped",
      message: `decode carries ${data.workouts?.length} workout messages — only the first was mapped`,
      context: { count: data.workouts?.length },
    });
  }
  const steps = [...(data.workout_steps ?? [])].sort((a, b) => indexOf(a.message_index) - indexOf(b.message_index));

  const entries: { record: Block; minIdx: number }[] = [];
  for (const step of steps) {
    const idx = indexOf(step.message_index);
    if (step.duration_type && REPEAT_DURATION.test(step.duration_type)) {
      const startIdx = num(step.duration_value) ?? idx;
      const rounds = num(step.target_value) ?? 1;
      const group: Block[] = [];
      for (let last = entries.at(-1); last !== undefined && last.minIdx >= startIdx; last = entries.at(-1)) {
        entries.pop();
        group.unshift(last.record);
      }
      entries.push({
        record: { id: `fit-wkt-blk-${idx}`, recordType: "Block", repetitions: rounds, children: group },
        minIdx: startIdx,
      });
    } else {
      // WorkUnit has no `name` field — a step's name is structural (§5.3), so it lives on
      // the single-child Block wrapping each step, not the WorkUnit itself.
      const block: Block = {
        id: `fit-wkt-blk-${idx}`,
        recordType: "Block",
        children: [stepToWorkUnit(step, idx)],
      };
      if (step.wkt_step_name) block.name = step.wkt_step_name;
      entries.push({ record: block, minIdx: idx });
    }
  }

  return [
    {
      id: "fit-wkt",
      recordType: "Session",
      subject,
      ...(wkt?.wkt_name ? { name: wkt.wkt_name } : {}),
      disciplines: [disciplineFor(wkt?.sport)],
      intent: "train",
      provenance: { method: "manual", sourceApp: "fit" },
      blocks: entries.map((e) => e.record),
    },
  ];
}

/**
 * One per-lap split → a `continuous` WorkUnit carrying whatever split totals the lap
 * message reported. All laps are mapped, in order (see `mapActivity`): a lap-structure
 * defect where a naive reader captures only the first lap (reported for some Suunto
 * exports) is exactly what iterating the full `laps` array here guards against. Sparse
 * laps (Suunto/Polar frequently omit distance or calories) just yield a leaner
 * performance — never a crash.
 */
function lapToWorkUnit(lap: DecodedLap, idx: number): WorkUnit {
  const perf: Performance = {};
  const distance = num(lap.total_distance);
  const time = num(lap.total_elapsed_time);
  const energy = num(lap.total_calories);
  if (distance != null) perf.distance = { absolute: { value: distance, unit: "m" } };
  if (time != null) perf.time = { absolute: { value: time, unit: "s" } };
  if (energy != null) perf.energy = { absolute: { value: energy, unit: "kcal" } };
  return { id: `fit-lap-wu-${idx}`, recordType: "WorkUnit", scoring: "continuous", performance: perf };
}

function mapActivity(data: FitInput, subject: string, warnings: MapWarning[]): LiveRecord[] {
  const s = data.sessions?.[0];
  if ((data.sessions?.length ?? 0) > 1) {
    warnings.push({
      code: "extra-sessions-dropped",
      message: `decode carries ${data.sessions?.length} session messages — only the first was mapped`,
      context: { count: data.sessions?.length },
    });
  }
  const laps = data.laps ?? [];
  const records = data.records ?? [];
  const start = s?.start_time ?? records[0]?.timestamp;
  // `start` is defined on every path that reads it: `s` guarantees start_time, and the
  // offsets map only runs over records that exist (records[0] then supplied `start`).
  const t0 = start !== undefined ? new Date(start).getTime() : NaN;
  const end = s ? iso(new Date(t0 + (num(s.total_elapsed_time) ?? 0) * 1000)) : records[records.length - 1]?.timestamp;
  const offsets = records.map((r) => (new Date(r.timestamp).getTime() - t0) / 1000);
  const prov = (method: Provenance["method"]): Provenance => ({ method, sourceApp: "fit" });

  const out: LiveRecord[] = [];
  const measuredBy: Link[] = [];
  const pushStream = makeScalarStream({
    records: out,
    measuredBy,
    subject,
    offsets,
    startTime: start,
    endTime: end,
    provenance: prov("sensor"),
  });
  const scalarStream = (id: string, type: string, unit: string, pick: (r: DecodedRecord) => number | undefined) => {
    const data = pickSeries(records, pick);
    if (data) pushStream(id, type, unit, data);
  };
  scalarStream("fit-hr", "heart_rate", "/min", (r) => num(r.heart_rate));
  scalarStream("fit-power", "power", "W", (r) => num(r.power));
  scalarStream("fit-cadence", "cadence", "/min", (r) => num(r.cadence));
  if (records.some((r) => num(r.position_lat) != null)) {
    out.push({
      id: "fit-route",
      recordType: "Measurement",
      subject,
      type: "location",
      sampleArray: {
        offsets,
        channels: [
          { name: "lat", unit: "deg" },
          { name: "lon", unit: "deg" },
          { name: "alt", unit: "m" },
        ],
        dataPoints: records.map((r) => [
          num(r.position_lat) ?? null,
          num(r.position_long) ?? null,
          num(r.altitude) ?? null,
        ]),
      },
      startTime: start,
      endTime: end,
      provenance: prov("sensor"),
    });
    measuredBy.push({ type: "measuredBy", ref: "fit-route" });
  }

  // Per-lap splits → one WorkUnit each (all laps, in order — the Suunto first-lap-only
  // guard). Absent laps fall back to a single session-summary WorkUnit so a lap-less
  // Garmin activity is mapped exactly as before.
  let workUnits: WorkUnit[];
  if (laps.length) {
    workUnits = laps.map((lap, i) => lapToWorkUnit(lap, i));
  } else {
    const perf: Performance = {};
    const distance = num(s?.total_distance);
    const time = num(s?.total_elapsed_time);
    const energy = num(s?.total_calories);
    if (distance != null) perf.distance = { absolute: { value: distance, unit: "m" } };
    if (time != null) perf.time = { absolute: { value: time, unit: "s" } };
    if (energy != null) perf.energy = { absolute: { value: energy, unit: "kcal" } };
    workUnits = [{ id: "fit-session-wu", recordType: "WorkUnit", scoring: "continuous", performance: perf }];
  }

  out.push({
    id: "fit-session",
    recordType: "Session",
    subject,
    disciplines: [disciplineFor(s?.sport)],
    intent: "train",
    startTime: start,
    endTime: end,
    provenance: prov("sensor"),
    links: measuredBy,
    workUnits,
  });
  return out;
}

/**
 * Map a *decoded* FIT activity or structured workout to OpenBody wire records: an
 * activity (`sessions`/`laps`/`records` messages) → Pillar A `sampleArray`
 * Measurements + a performed Session (one WorkUnit per lap when lap messages are
 * present, else a single session-summary WorkUnit); a workout
 * (`workouts`/`workout_steps` messages) → a planned Session of Block/WorkUnit
 * prescriptions.
 *
 * Non-Garmin robustness (OB-83): numeric fields are read tolerantly — a tolerant
 * decoder's array/`{ value }` wrapping of a scalar (COROS's field-size spec
 * violation, python-fitparse#116) is normalized, not mis-read; every lap is mapped
 * (guarding the first-lap-only defect seen in some Suunto exports); and missing
 * optional fields (sparse Polar FIT) simply omit their target rather than crash.
 *
 * Input precondition: this mapper never decodes FIT's binary format itself (see the
 * file header for why) — `input` must be the message-list shape a FIT SDK decoder
 * produces in `mode: "list"`, carrying at least one of `sessions`/`laps`/`records`/
 * `workouts`/`workout_steps`. An input with none of those arrays throws
 * {@link MapperInputError} (`mapper: "fit"`).
 *
 * `opts.utcOffset` is not applicable: decoded FIT timestamps are already absolute
 * instants (the FIT SDK resolves them from the binary's compressed-timestamp
 * encoding).
 *
 * Warnings this mapper can emit: `default-subject` (no `opts.subject` given),
 * `extra-sessions-dropped` / `extra-workouts-dropped` (multiple session/workout
 * messages present — only the first is mapped).
 */
export function mapFit(input: FitInput, opts: MapOptions = {}): MapperResult {
  // Structural minimum (WP7): the decoded message-list shape. A decode with NONE of
  // the message lists present isn't the documented `mode: "list"` output of any FIT
  // file — fabricating a Session from zero messages would be dishonest.
  if (
    input === null ||
    typeof input !== "object" ||
    (input.sessions === undefined &&
      input.laps === undefined &&
      input.records === undefined &&
      input.workouts === undefined &&
      input.workout_steps === undefined)
  ) {
    throw new MapperInputError(
      "fit",
      'input carries none of the decoded FIT message lists (sessions/laps/records/workouts/workout_steps) — pass a FIT decoder\'s mode:"list" output',
    );
  }
  const warnings: MapWarning[] = [];
  const subject = subjectFor(opts, warnings, "fit");
  const records = input.workouts?.length ? mapWorkout(input, subject, warnings) : mapActivity(input, subject, warnings);
  return { records, warnings };
}
