// Strava activity + streams → OpenBody Pillar A Measurements (sampleArray) + a Pillar B
// Session linked by measuredBy. Input is the documented activity+streams wire shape.
import { MapperInputError } from "../errors.js";
import type { Link, LiveRecord, MapOptions, MapperResult, MapWarning, Provenance, WireRecord } from "../types.js";
import { iso, makeDisciplineMapper, makeScalarStream, subjectFor } from "./shared.js";

/** The documented Strava API activity+streams wire shape (input side — WireRecord-loose, not OpenBody records). */
export interface StravaInput {
  activity: WireRecord;
  streams: WireRecord;
}

// sport_type (CamelCase API enum) → registry discipline token (vocab/disciplines.json);
// unknown types round-trip as namespaced tokens (strava:<type>, §4.4 ladder), same as gpx.ts/fit.ts.
const DISC: Record<string, string> = {
  Run: "running",
  VirtualRun: "running",
  TrailRun: "trail_running",
  Ride: "cycling",
  VirtualRide: "cycling",
  GravelRide: "cycling",
  EBikeRide: "cycling",
  EMountainBikeRide: "mountain_biking",
  MountainBikeRide: "mountain_biking",
  Swim: "swimming",
  Hike: "hiking",
  Walk: "walking",
  Rowing: "rowing",
  VirtualRow: "rowing",
  WeightTraining: "strength",
  Crossfit: "functional_fitness",
  Yoga: "yoga",
  Pilates: "pilates",
  RockClimbing: "climbing",
};
const mapDiscipline = makeDisciplineMapper(DISC, "strava");
const disciplineFor = (t: string): string => mapDiscipline(t, t.toLowerCase());

/**
 * Map a Strava activity + streams object (the documented API wire shape) to OpenBody
 * wire records: one `sampleArray` Measurement per fetched telemetry stream (HR/power/
 * cadence, plus a multi-channel lat/lon/alt location series), avg/max-HR interval
 * aggregates `derivedFrom` the HR stream, and a Session linking them all via
 * `measuredBy`.
 *
 * Input precondition: `input.activity` must be present, `input.activity.start_date`
 * a parseable timestamp, `input.activity.elapsed_time` a number, and
 * `input.streams.time.data` an array (sampleArray offsets are computed from it) —
 * missing any of these throws {@link MapperInputError} (`mapper: "strava"`).
 *
 * `opts.utcOffset` is not applicable: the Strava API's `start_date` already carries
 * an offset.
 *
 * Warnings this mapper can emit: `default-subject` (no `opts.subject` given).
 */
export function mapStrava(input: StravaInput, opts: MapOptions = {}): MapperResult {
  const warnings: MapWarning[] = [];
  const subject = subjectFor(opts, warnings, "strava");
  const a = input?.activity,
    s = input?.streams;
  // Structural minimum (WP7): the activity's identity/timing fields and the time
  // stream — nothing downstream is computable without them.
  if (!a || typeof a !== "object")
    throw new MapperInputError("strava", "input.activity is missing — pass the Strava API activity object");
  if (!Array.isArray(s?.time?.data))
    throw new MapperInputError(
      "strava",
      'streams.time.data is missing — fetch the activity streams with keys including "time" (sampleArray offsets cannot be computed without it)',
    );
  if (typeof a.start_date !== "string" || Number.isNaN(Date.parse(a.start_date)))
    throw new MapperInputError(
      "strava",
      `activity.start_date is missing or not a parseable timestamp (got ${JSON.stringify(a.start_date)})`,
    );
  if (typeof a.elapsed_time !== "number")
    throw new MapperInputError(
      "strava",
      `activity.elapsed_time is missing or not a number (got ${JSON.stringify(a.elapsed_time)})`,
    );
  const start = a.start_date;
  const end = iso(new Date(new Date(start).getTime() + a.elapsed_time * 1000));
  const offsets: number[] = s.time.data;
  // device_name is a free-form display string; Strava does not state the manufacturer
  // separately, so none is fabricated (model-only, same as tcx.ts's <Creator>).
  const device = a.device_name ? { model: a.device_name } : undefined;
  const prov = (method: Provenance["method"]): Provenance => ({
    method,
    sourceApp: "strava",
    ...(device ? { device } : {}),
  });

  const records: LiveRecord[] = [];
  const measuredBy: Link[] = [];

  const scalarStream = makeScalarStream({
    records,
    measuredBy,
    subject,
    offsets,
    startTime: start,
    endTime: end,
    provenance: prov("sensor"),
  });
  if (s.heartrate) scalarStream(`strava-${a.id}-hr`, "heart_rate", "/min", s.heartrate.data);
  if (s.watts) scalarStream(`strava-${a.id}-power`, "power", "W", s.watts.data);
  if (s.cadence) scalarStream(`strava-${a.id}-cadence`, "cadence", "/min", s.cadence.data);
  if (s.latlng) {
    const id = `strava-${a.id}-route`;
    const dataPoints = s.latlng.data.map((ll: number[], i: number) => [
      ll[0],
      ll[1],
      s.altitude ? s.altitude.data[i] : null,
    ]);
    records.push({
      id,
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
        dataPoints,
      },
      startTime: start,
      endTime: end,
      provenance: prov("sensor"),
    });
    measuredBy.push({ type: "measuredBy", ref: id });
  }

  // Summary HR aggregates derive from the HR stream, but that stream exists only when it was
  // fetched — link it conditionally (tcx.ts precedent), never emit a dangling derivedFrom.
  // provenance.algorithm required with the aggregate (§7.4); Strava doesn't publish it, record a best-effort name.
  const hrRef = `strava-${a.id}-hr`;
  const aggregate = (id: string, type: string, value: number, unit: string) => {
    records.push({
      id,
      recordType: "Measurement",
      subject,
      type,
      quantity: value,
      unit,
      startTime: start,
      endTime: end,
      provenance: { ...prov("algorithm"), algorithm: { name: "strava-summary", version: "v3" } },
      ...(s.heartrate ? { links: [{ type: "derivedFrom", ref: hrRef }] } : {}),
    });
  };
  if (a.average_heartrate != null) aggregate(`strava-${a.id}-hr-mean`, "heart_rate_mean", a.average_heartrate, "/min");
  if (a.max_heartrate != null) aggregate(`strava-${a.id}-hr-max`, "heart_rate_max", a.max_heartrate, "/min");

  records.push({
    id: `strava-${a.id}`,
    recordType: "Session",
    subject,
    // The activity's user-facing title ("Morning Run") — same source-title → Session.name
    // posture as the gpx/tcx/hevy/concept2 mappers.
    ...(a.name ? { name: a.name } : {}),
    disciplines: [disciplineFor(String(a.sport_type || a.type))],
    intent: "train",
    startTime: start,
    endTime: end,
    provenance: prov("sensor"),
    workUnits: [
      {
        id: `strava-${a.id}-wu`,
        recordType: "WorkUnit",
        scoring: "continuous",
        performance: {
          distance: { absolute: { value: a.distance, unit: "m" } },
          time: { absolute: { value: a.moving_time, unit: "s" } },
        },
        links: measuredBy,
      },
    ],
  });
  return { records, warnings };
}
