// Strava activity + streams → OpenBody Pillar A Measurements (sampleArray) + a Pillar B
// Session linked by measuredBy. Input is the documented activity+streams wire shape.
import { type OpenBodyRecord, type MapOptions } from "./csv.js";

export interface StravaInput { activity: Record<string, any>; streams: Record<string, any> }

/** Map a Strava activity + streams object to OpenBody wire records. */
export function mapStrava(input: StravaInput, opts: MapOptions = {}): OpenBodyRecord[] {
  const subject = opts.subject ?? "subj-001";
  const a = input.activity, s = input.streams;
  const start = a.start_date;
  const end = new Date(new Date(start).getTime() + a.elapsed_time * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const offsets: number[] = s.time.data;
  const device = a.device_name ? { manufacturer: "garmin", model: a.device_name } : undefined;
  const prov = (method: string) => ({ method, sourceApp: "strava", ...(device ? { device } : {}) });

  const records: OpenBodyRecord[] = [];
  const measuredBy: { type: string; ref: string }[] = [];

  const scalarStream = (id: string, type: string, unit: string, data: (number | null)[]) => {
    records.push({ id, recordType: "Measurement", subject, type, unit,
      sampleArray: { offsets, dataPoints: data }, startTime: start, endTime: end, provenance: prov("sensor") });
    measuredBy.push({ type: "measuredBy", ref: id });
  };
  if (s.heartrate) scalarStream(`strava-${a.id}-hr`, "heart_rate", "/min", s.heartrate.data);
  if (s.watts) scalarStream(`strava-${a.id}-power`, "power", "W", s.watts.data);
  if (s.cadence) scalarStream(`strava-${a.id}-cadence`, "cadence", "/min", s.cadence.data);
  if (s.latlng) {
    const id = `strava-${a.id}-route`;
    const dataPoints = s.latlng.data.map((ll: number[], i: number) => [ll[0], ll[1], s.altitude ? s.altitude.data[i] : null]);
    records.push({ id, recordType: "Measurement", subject, type: "location",
      sampleArray: { offsets, channels: [{ name: "lat", unit: "deg" }, { name: "lon", unit: "deg" }, { name: "alt", unit: "m" }], dataPoints },
      startTime: start, endTime: end, provenance: prov("sensor") });
    measuredBy.push({ type: "measuredBy", ref: id });
  }

  const aggregate = (id: string, type: string, value: number, unit: string, fromRef: string) => {
    records.push({ id, recordType: "Measurement", subject, type, quantity: value, unit,
      startTime: start, endTime: end, provenance: prov("algorithm"),
      links: [{ type: "derivedFrom", ref: fromRef }] });
  };
  const hrRef = `strava-${a.id}-hr`;
  if (a.average_heartrate != null) aggregate(`strava-${a.id}-hr-mean`, "heart_rate_mean", a.average_heartrate, "/min", hrRef);
  if (a.max_heartrate != null) aggregate(`strava-${a.id}-hr-max`, "heart_rate_max", a.max_heartrate, "/min", hrRef);
  // derivedFrom ⇒ provenance.algorithm required (§7.4); Strava doesn't publish it, record a best-effort name.
  for (const r of records) if (r.links?.some((l: any) => l.type === "derivedFrom")) r.provenance.algorithm = { name: "strava-summary", version: "v3" };

  records.push({
    id: `strava-${a.id}`, recordType: "Session", subject,
    disciplines: [String(a.sport_type || a.type).toLowerCase()], intent: "train",
    startTime: start, endTime: end, provenance: prov("sensor"),
    workUnits: [{
      id: `strava-${a.id}-wu`, recordType: "WorkUnit", scoring: "continuous",
      performance: { distance: { absolute: { value: a.distance, unit: "m" } }, time: { absolute: { value: a.moving_time, unit: "s" } } },
      links: measuredBy,
    }],
  });
  return records;
}
