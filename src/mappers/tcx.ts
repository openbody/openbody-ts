// TCX (Garmin Training Center XML, TrainingCenterDatabase/v2) → OpenBody wire
// records: one Session per <Activity> (Sport attr → discipline token), one WorkUnit
// per <Lap> carrying time/distance/calories, and Trackpoint streams → sampleArray
// Measurements (HR, cadence, power via the ActivityExtension TPX <Watts>, and a
// multi-channel lat/lon/alt location series per §4.3) linked from the Session via
// measuredBy. Format-level support: covers Garmin Connect, Polar legacy exports,
// MapMyRun, and any other TCX v2 exporter. OB-79.
//
// Built against official schemas + public samples (Garmin's TrainingCenterDatabasev2
// and ActivityExtensionv2 XSDs); verify against real platform exports (OB-79
// acceptance).
//
// Parsing: the same no-DOM technique as apple-health.ts — namespace-prefix-tolerant
// regex extraction over the raw XML string — browser-safe AND node-safe, zero deps
// (<ns3:Watts> and <Watts> both match).
//
// Shape decisions:
// - Lap → WorkUnit (not Block). A TCX lap is a contiguous, atomically-scored slice
//   of one continuous effort — exactly OpenBody's WorkUnit atom (§5.5) — with no
//   grouping/repetition semantics that would earn a Block (§5.4). Laps therefore
//   land as Session.workUnits (the collapsed §5.1 hierarchy: Block and Exercise
//   tiers omitted, as producers MUST NOT be forced to invent tiers they have no
//   data for), each scored `continuous` with performance time (TotalTimeSeconds, s),
//   distance (DistanceMeters, m), and energy (Calories, kcal), and its own
//   startTime from the Lap StartTime attribute (§5.3: an inlined child MAY carry
//   overriding occurrence time).
// - Lap <Intensity>: "Active" is the TCX default and adds no information, so it is
//   not emitted; "Resting" becomes setRole "tcx:resting" (namespaced — the core
//   setRole vocabulary has no rest token; §5.9 open-token ladder).
// - Lap AverageHeartRateBpm/MaximumHeartRateBpm → interval `quantity` aggregate
//   Measurements (§4.3 "aggregates are not a special shape") with a derivedFrom
//   link to the HR stream when one exists, and provenance.method "algorithm"
//   (the head unit computed them; algorithm named best-effort, as in strava.ts).
// - Sport attr: Running → running, Biking → cycling; TCX's only other value,
//   "Other", round-trips namespaced as tcx:other (§4.4 ladder).
// - <Activity><Id> (the activity's key in every TCX producer) → clientRecordId
//   (§7.1, round-trip + within-source dedup); <Creator><Name> → provenance.device
//   .model (the manufacturer is not stated separately, so none is fabricated).
// - Multiple <Activity> elements → multiple Sessions (ids tcx-1, tcx-2, …); the
//   legs of a <MultiSportSession> are plain <Activity> elements and map the same
//   way (one Session per leg; no umbrella record is emitted).
// - Unsupported, documented: <Courses> (planned routes to follow, not performed or
//   prescribed training) and <Workouts> (step prescriptions — structurally the FIT
//   workout shape; use mapFit for a decoded workout). A file containing only those
//   maps to [] gracefully. Trackpoint ns3:Speed is not mapped (derivable from the
//   location series); per-point DistanceMeters likewise.
import { type OpenBodyRecord, type MapOptions } from "./csv.js";

// ---- minimal namespace-tolerant XML helpers (no DOMParser, no node deps) ----
const NAME = "[A-Za-z_][\\w.-]*";
const elRe = (tag: string) =>
  new RegExp(`<(?:${NAME}:)?${tag}((?:\\s[^>]*?)?)(?:/>|>([\\s\\S]*?)</(?:${NAME}:)?${tag}\\s*>)`, "g");
interface El { attrs: Record<string, string>; inner: string }
function* els(xml: string, tag: string): Generator<El> {
  for (const m of xml.matchAll(elRe(tag)))
    yield { attrs: Object.fromEntries([...(m[1] ?? "").matchAll(/([\w:.-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])), inner: m[2] ?? "" };
}
const first = (xml: string, tag: string): El | undefined => els(xml, tag).next().value;
const text = (xml: string, tag: string): string | undefined => {
  const t = first(xml, tag)?.inner.trim();
  return t === "" ? undefined : t;
};
const numText = (xml: string, tag: string): number | undefined => {
  const t = text(xml, tag);
  return t == null ? undefined : Number(t);
};
const wrappedValue = (xml: string, tag: string): number | undefined => {
  const el = first(xml, tag); // TCX HeartRateInBeatsPerMinute_t: <Tag><Value>n</Value></Tag>
  return el ? numText(el.inner, "Value") : undefined;
};
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const SPORT: Record<string, string> = { Running: "running", Biking: "cycling" };

interface Tp { time?: string; lat?: number; lon?: number; alt?: number; hr?: number; cad?: number; watts?: number }

/** Map a TCX (TrainingCenterDatabase v2) document string to OpenBody wire records (see file header for shape decisions). */
export function mapTcx(xml: string, opts: MapOptions = {}): OpenBodyRecord[] {
  const subject = opts.subject ?? "subj-001";
  const records: OpenBodyRecord[] = [];
  let n = 0;

  for (const act of els(xml, "Activity")) {
    n++;
    const base = `tcx-${n}`;
    const sport = act.attrs.Sport;
    const discipline = (sport && SPORT[sport]) || `tcx:${(sport ?? "other").toLowerCase()}`;
    const actId = text(act.inner, "Id");
    const creatorName = (() => { const c = first(act.inner, "Creator"); return c ? text(c.inner, "Name") : undefined; })();
    const prov = (method: string): OpenBodyRecord =>
      ({ method, sourceApp: "tcx", ...(creatorName ? { device: { model: creatorName } } : {}) });

    // Laps: per-lap metadata (Track blocks stripped so a Trackpoint's Cadence /
    // DistanceMeters can't shadow the lap-level fields) + concatenated trackpoints.
    const laps: { attrs: Record<string, string>; meta: string }[] = [];
    const tps: Tp[] = [];
    for (const lap of els(act.inner, "Lap")) {
      laps.push({ attrs: lap.attrs, meta: lap.inner.replace(elRe("Track"), "") });
      for (const track of els(lap.inner, "Track"))
        for (const tp of els(track.inner, "Trackpoint")) {
          const pos = first(tp.inner, "Position");
          const ext = first(tp.inner, "Extensions")?.inner ?? "";
          tps.push({
            time: text(tp.inner, "Time"),
            lat: pos ? numText(pos.inner, "LatitudeDegrees") : undefined,
            lon: pos ? numText(pos.inner, "LongitudeDegrees") : undefined,
            alt: numText(tp.inner, "AltitudeMeters"),
            hr: wrappedValue(tp.inner, "HeartRateBpm"),
            cad: numText(tp.inner, "Cadence"),
            watts: numText(ext, "Watts"),
          });
        }
    }

    // ---- Pillar A: trackpoint streams (timed points only — offsets need timestamps) ----
    const timed = tps.filter((t) => t.time);
    const measuredBy: OpenBodyRecord[] = [];
    let mStart: string | undefined, mEnd: string | undefined;
    if (timed.length) {
      mStart = timed[0].time!; mEnd = timed[timed.length - 1].time!;
      const t0 = Date.parse(mStart);
      const offsets = timed.map((t) => (Date.parse(t.time!) - t0) / 1000);
      if (timed.some((t) => t.lat != null)) {
        records.push({
          id: `${base}-route`, recordType: "Measurement", subject, type: "location",
          sampleArray: {
            offsets,
            channels: [{ name: "lat", unit: "deg" }, { name: "lon", unit: "deg" }, { name: "alt", unit: "m" }],
            dataPoints: timed.map((t) => [t.lat ?? null, t.lon ?? null, t.alt ?? null]),
          },
          startTime: mStart, endTime: mEnd, provenance: prov("sensor"),
        });
        measuredBy.push({ type: "measuredBy", ref: `${base}-route` });
      }
      const scalarStream = (id: string, type: string, unit: string, pick: (t: Tp) => number | undefined) => {
        const data = timed.map((t) => pick(t) ?? null);
        if (data.every((v) => v === null)) return;
        records.push({ id, recordType: "Measurement", subject, type, unit,
          sampleArray: { offsets, dataPoints: data }, startTime: mStart, endTime: mEnd, provenance: prov("sensor") });
        measuredBy.push({ type: "measuredBy", ref: id });
      };
      scalarStream(`${base}-hr`, "heart_rate", "/min", (t) => t.hr);
      scalarStream(`${base}-cadence`, "cadence", "/min", (t) => t.cad);
      scalarStream(`${base}-power`, "power", "W", (t) => t.watts);
    }
    const hrStream = measuredBy.find((l) => l.ref === `${base}-hr`);

    // ---- Pillar B: Lap → WorkUnit (+ lap HR aggregates, §4.3) ----
    const workUnits = laps.map((lap, i) => {
      const li = i + 1;
      const lapStart = lap.attrs.StartTime;
      const t = numText(lap.meta, "TotalTimeSeconds");
      const perf: OpenBodyRecord = {};
      if (t != null) perf.time = { absolute: { value: t, unit: "s" } };
      const d = numText(lap.meta, "DistanceMeters");
      if (d != null) perf.distance = { absolute: { value: d, unit: "m" } };
      const cal = numText(lap.meta, "Calories");
      if (cal != null) perf.energy = { absolute: { value: cal, unit: "kcal" } };

      const wu: OpenBodyRecord = { id: `${base}-lap-${li}`, recordType: "WorkUnit", scoring: "continuous", performance: perf };
      if (lapStart) wu.startTime = lapStart;
      const intensity = text(lap.meta, "Intensity");
      if (intensity && intensity !== "Active") wu.setRole = `tcx:${intensity.toLowerCase()}`;

      if (lapStart && t != null) {
        const lapEnd = iso(Date.parse(lapStart) + t * 1000);
        const aggregate = (id: string, type: string, value: number | undefined) => {
          if (value == null) return;
          records.push({
            id, recordType: "Measurement", subject, type, quantity: value, unit: "/min",
            startTime: lapStart, endTime: lapEnd,
            provenance: { ...prov("algorithm"), algorithm: { name: "tcx-lap-summary", version: "TrainingCenterDatabase/v2" } },
            ...(hrStream ? { links: [{ type: "derivedFrom", ref: `${base}-hr` }] } : {}),
          });
        };
        aggregate(`${base}-lap-${li}-hr-mean`, "heart_rate_mean", wrappedValue(lap.meta, "AverageHeartRateBpm"));
        aggregate(`${base}-lap-${li}-hr-max`, "heart_rate_max", wrappedValue(lap.meta, "MaximumHeartRateBpm"));
      }
      return wu;
    });

    const start = laps[0]?.attrs.StartTime ?? actId ?? mStart;
    const totalSec = laps.reduce((s, l) => s + (numText(l.meta, "TotalTimeSeconds") ?? 0), 0);
    const end = mEnd ?? (start && totalSec ? iso(Date.parse(start) + totalSec * 1000) : undefined);

    records.push({
      id: base, recordType: "Session", subject,
      ...(actId ? { clientRecordId: actId } : {}),
      disciplines: [discipline], intent: "train",
      ...(start ? { startTime: start } : {}), ...(end ? { endTime: end } : {}),
      provenance: prov("sensor"),
      ...(measuredBy.length ? { links: measuredBy } : {}),
      ...(workUnits.length ? { workUnits } : {}),
    });
  }
  // No <Activity> at all (e.g. a Courses- or Workouts-only file): unsupported content,
  // reported gracefully as an empty document (see header).
  return records;
}
