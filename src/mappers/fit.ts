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
import type { MapOptions, OpenBodyRecord } from "../types.js";

interface DecodedRecord {
  timestamp: string;
  position_lat?: number;
  position_long?: number;
  altitude?: number;
  heart_rate?: number;
  power?: number;
  cadence?: number;
}
interface DecodedLap {
  timestamp: string;
  start_time?: string;
  total_elapsed_time?: number;
  total_distance?: number;
  total_calories?: number;
}
interface DecodedSession {
  start_time: string;
  sport?: string;
  total_elapsed_time?: number;
  total_distance?: number;
  total_calories?: number;
  avg_heart_rate?: number;
  max_heart_rate?: number;
  avg_power?: number;
  max_power?: number;
}
interface DecodedWorkout {
  wkt_name?: string;
  sport?: string;
  num_valid_steps?: number;
}
interface DecodedWorkoutStep {
  message_index: { value: number } | number;
  wkt_step_name?: string;
  duration_type?: string;
  duration_value?: number;
  target_type?: string;
  target_value?: number;
  custom_target_value_low?: number;
  custom_target_value_high?: number;
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
const disciplineFor = (sport?: string) => (sport && SPORT[sport]) || `fit:${sport ?? "generic"}`;

const indexOf = (mi: DecodedWorkoutStep["message_index"]) => (typeof mi === "number" ? mi : mi.value);

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

function targetValue(step: DecodedWorkoutStep): OpenBodyRecord | undefined {
  const low = step.custom_target_value_low,
    high = step.custom_target_value_high;
  if (low != null && high != null) {
    // SPEC.md's own Zwift crosswalk (Warmup/Cooldown/Ramp → Intensity.value `ramp`) is the
    // precedent: a warmup/cooldown step's target band is directional, not a plain range.
    if (step.intensity === "warmup") return { ramp: { from: low, to: high } };
    if (step.intensity === "cooldown") return { ramp: { from: high, to: low } };
    return { range: { min: low, max: high } };
  }
  if (step.target_value != null) return { absolute: { value: step.target_value } };
  return undefined; // target_type "open" (or no value at all): athlete's choice, no target.
}

function stepToWorkUnit(step: DecodedWorkoutStep, idx: number): OpenBodyRecord {
  const wu: OpenBodyRecord = { id: `fit-wkt-wu-${idx}`, recordType: "WorkUnit" };
  const setRole = setRoleFor(step.intensity);
  if (setRole) wu.setRole = setRole;

  const prescription: OpenBodyRecord = {};
  switch (step.duration_type) {
    case "distance":
      wu.scoring = "distance";
      prescription.distance = { absolute: { value: step.duration_value, unit: "m" } };
      break;
    case "reps":
      wu.scoring = "reps";
      prescription.reps = step.duration_value;
      break;
    case "calories":
      wu.scoring = "energy";
      prescription.energy = { absolute: { value: step.duration_value, unit: "kcal" } };
      break;
    case "open":
      wu.scoring = "time";
      prescription.time = { stopCondition: { kind: "open" } };
      break;
    case "time":
      wu.scoring = "time";
      prescription.time = { absolute: { value: step.duration_value, unit: "s" } };
      break;
    default:
      // Exotic conditional-stop durations (hr_less_than, power_greater_than, …): rare in
      // practice. Canonical-plus-residue (per the mapping guide's principles): degrade to a
      // valid, generically-scored WorkUnit and preserve the raw FIT condition losslessly.
      wu.scoring = "continuous";
      prescription.time = { stopCondition: { kind: "open" } };
      wu.extension = { fit: { duration_type: step.duration_type } };
  }

  const dim = step.target_type && INTENSITY_DIM[step.target_type];
  if (dim) {
    const value = targetValue(step);
    if (value) prescription.intensity = [{ dimension: dim.dimension, unit: dim.unit, value }];
  }
  wu.prescription = prescription;
  return wu;
}

function mapWorkout(data: FitInput, subject: string): OpenBodyRecord[] {
  const wkt = data.workouts?.[0];
  const steps = [...(data.workout_steps ?? [])].sort((a, b) => indexOf(a.message_index) - indexOf(b.message_index));

  const entries: { record: OpenBodyRecord; minIdx: number }[] = [];
  for (const step of steps) {
    const idx = indexOf(step.message_index);
    if (step.duration_type && REPEAT_DURATION.test(step.duration_type)) {
      const startIdx = step.duration_value ?? idx;
      const rounds = step.target_value ?? 1;
      const group: OpenBodyRecord[] = [];
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
      const block: OpenBodyRecord = {
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

function mapActivity(data: FitInput, subject: string): OpenBodyRecord[] {
  const s = data.sessions?.[0];
  const records = data.records ?? [];
  const start = s?.start_time ?? records[0]?.timestamp;
  // `start` is defined on every path that reads it: `s` guarantees start_time, and the
  // offsets map only runs over records that exist (records[0] then supplied `start`).
  const t0 = start !== undefined ? new Date(start).getTime() : NaN;
  const end = s
    ? new Date(t0 + (s.total_elapsed_time ?? 0) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
    : records[records.length - 1]?.timestamp;
  const offsets = records.map((r) => (new Date(r.timestamp).getTime() - t0) / 1000);
  const prov = (method: string) => ({ method, sourceApp: "fit" });

  const out: OpenBodyRecord[] = [];
  const measuredBy: OpenBodyRecord[] = [];
  const scalarStream = (id: string, type: string, unit: string, pick: (r: DecodedRecord) => number | undefined) => {
    const data_ = records.map((r) => pick(r) ?? null);
    if (data_.every((v) => v === null)) return;
    out.push({
      id,
      recordType: "Measurement",
      subject,
      type,
      unit,
      sampleArray: { offsets, dataPoints: data_ },
      startTime: start,
      endTime: end,
      provenance: prov("sensor"),
    });
    measuredBy.push({ type: "measuredBy", ref: id });
  };
  scalarStream("fit-hr", "heart_rate", "/min", (r) => r.heart_rate);
  scalarStream("fit-power", "power", "W", (r) => r.power);
  scalarStream("fit-cadence", "cadence", "/min", (r) => r.cadence);
  if (records.some((r) => r.position_lat != null)) {
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
        dataPoints: records.map((r) => [r.position_lat ?? null, r.position_long ?? null, r.altitude ?? null]),
      },
      startTime: start,
      endTime: end,
      provenance: prov("sensor"),
    });
    measuredBy.push({ type: "measuredBy", ref: "fit-route" });
  }

  const perf: OpenBodyRecord = {};
  if (s?.total_distance != null) perf.distance = { absolute: { value: s.total_distance, unit: "m" } };
  if (s?.total_elapsed_time != null) perf.time = { absolute: { value: s.total_elapsed_time, unit: "s" } };
  if (s?.total_calories != null) perf.energy = { absolute: { value: s.total_calories, unit: "kcal" } };

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
    workUnits: [{ id: "fit-session-wu", recordType: "WorkUnit", scoring: "continuous", performance: perf }],
  });
  return out;
}

/** Map a decoded FIT activity or workout file to OpenBody wire records (see file header for the decode-input contract). */
export function mapFit(input: FitInput, opts: MapOptions = {}): OpenBodyRecord[] {
  const subject = opts.subject ?? "subj-001";
  return input.workouts?.length ? mapWorkout(input, subject) : mapActivity(input, subject);
}
