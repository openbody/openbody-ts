// GPX (GPS Exchange Format, topografix) → OpenBody wire records: one Session + a
// multi-channel location Measurement (lat/lon/alt per §4.3's registry convention),
// plus separate HR/cadence/power Measurements when Garmin TrackPointExtension (or
// Strava-style <power>) data is present — all linked from the Session via measuredBy.
// Format-level support: covers Runkeeper, Komoot, AllTrails, Ride with GPS, MapMyRun,
// and any other GPX 1.1 (or 1.0) exporter. OB-79.
//
// Built against official schemas + public samples (GPX 1.1 XSD at topografix.com,
// Garmin TrackPointExtension XSD, Wikipedia's public GPX example); verify against
// real platform exports (OB-79 acceptance).
//
// Parsing: the same no-DOM technique as apple-health.ts — regex extraction over the
// raw XML string — so the mapper stays browser-safe AND node-safe with zero
// dependencies. Element matching is namespace-prefix tolerant (<gpxtpx:hr>, <ns3:hr>,
// and <hr> all match), which is also what makes GPX 1.0 parse identically: 1.0 uses
// the same trk/trkseg/trkpt element names, only the xmlns differs, and this parser
// never looks at namespaces.
//
// Shape decisions:
// - All <trk>/<trkseg> concatenate into ONE Session + one location series. GPX
//   segments mark GPS dropouts / pauses inside a single recording (GPX 1.1 §trkseg),
//   not separate activities; per-point timestamps keep the offsets honest across the
//   gap, so nothing is lost by concatenating.
// - Missing <time>: sampleArray requires exactly one of frequencyHz|offsets (§4.3),
//   and a GPX file states neither — fabricating timing would be dishonest. A fully
//   untimed track therefore emits only the Session (undated: §5.3 startTime is
//   recommended, not required) with the raw geometry preserved losslessly in
//   extension.gpx.untimedTrack (canonical-plus-residue, same posture as fit.ts).
//   A mixed file keeps the timed points and counts the dropped untimed ones in
//   extension.gpx.droppedUntimedPoints.
// - Waypoint-only (<wpt>) and route-only (<rte>) files map to [] — waypoints are map
//   annotations and routes are planned paths, not observations of a subject, so
//   there is nothing OpenBody-representable; the mapper reports this gracefully by
//   returning an empty document rather than throwing.
// - <trk><type> → discipline via a small token map; unknown types round-trip as
//   namespaced tokens (gpx:<type>, §4.4 ladder); absent type ⇒ no disciplines
//   (a generic session).
// - The <gpx creator="…"> attribute is free-form vendor text, not a registry token,
//   so it is preserved in extension.gpx.creator rather than forced into
//   provenance.sourceApp (which carries the format token "gpx").
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

const DISC: Record<string, string> = {
  running: "running", run: "running", trail_running: "running",
  cycling: "cycling", ride: "cycling", biking: "cycling", bike: "cycling", mountain_biking: "cycling",
  hiking: "hiking", hike: "hiking",
  walking: "walking", walk: "walking",
  swimming: "swimming", swim: "swimming",
  rowing: "rowing", row: "rowing",
};
const disciplineFor = (t?: string): string | undefined =>
  t ? DISC[t.toLowerCase().replace(/\s+/g, "_")] ?? `gpx:${t.toLowerCase()}` : undefined;

interface Pt { lat: number; lon: number; ele?: number; time?: string; hr?: number; cad?: number; power?: number }

/** Map a GPX 1.1 (or 1.0) document string to OpenBody wire records (see file header for shape decisions). */
export function mapGpx(xml: string, opts: MapOptions = {}): OpenBodyRecord[] {
  const subject = opts.subject ?? "subj-001";

  const pts: Pt[] = [];
  let trkName: string | undefined, trkType: string | undefined;
  for (const trk of els(xml, "trk")) {
    trkName ??= text(trk.inner, "name");
    trkType ??= text(trk.inner, "type");
    for (const seg of els(trk.inner, "trkseg"))
      for (const p of els(seg.inner, "trkpt")) {
        const ext = first(p.inner, "extensions")?.inner ?? "";
        pts.push({
          lat: Number(p.attrs.lat), lon: Number(p.attrs.lon),
          ele: numText(p.inner, "ele"), time: text(p.inner, "time"),
          hr: numText(ext, "hr"),
          cad: numText(ext, "cad") ?? numText(ext, "cadence"),
          power: numText(ext, "power"),
        });
      }
  }
  if (pts.length === 0) return []; // waypoint-only / route-only / empty: nothing subject-observed (see header).

  const creator = first(xml, "gpx")?.attrs.creator;
  const gpxExt: Record<string, unknown> = {};
  if (creator) gpxExt.creator = creator;
  const prov = { method: "sensor", sourceApp: "gpx" };
  const discipline = disciplineFor(trkType);

  const timed = pts.filter((p) => p.time);
  if (timed.length === 0) {
    // Untimed track: no offsets are representable (§4.3) — Session only, geometry kept losslessly.
    gpxExt.untimedTrack = { channels: ["lat", "lon", "alt"], points: pts.map((p) => [p.lat, p.lon, p.ele ?? null]) };
    return [{
      id: "gpx-session", recordType: "Session", subject,
      ...(trkName ? { name: trkName } : {}),
      ...(discipline ? { disciplines: [discipline] } : {}),
      intent: "train", provenance: prov, extension: { gpx: gpxExt },
    }];
  }
  if (timed.length < pts.length) gpxExt.droppedUntimedPoints = pts.length - timed.length;

  const start = timed[0].time!, end = timed[timed.length - 1].time!;
  const t0 = Date.parse(start);
  const offsets = timed.map((p) => (Date.parse(p.time!) - t0) / 1000);

  const records: OpenBodyRecord[] = [];
  const measuredBy: OpenBodyRecord[] = [];
  records.push({
    id: "gpx-route", recordType: "Measurement", subject, type: "location",
    sampleArray: {
      offsets,
      channels: [{ name: "lat", unit: "deg" }, { name: "lon", unit: "deg" }, { name: "alt", unit: "m" }],
      dataPoints: timed.map((p) => [p.lat, p.lon, p.ele ?? null]),
    },
    startTime: start, endTime: end, provenance: prov,
  });
  measuredBy.push({ type: "measuredBy", ref: "gpx-route" });

  const scalarStream = (id: string, type: string, unit: string, pick: (p: Pt) => number | undefined) => {
    const data = timed.map((p) => pick(p) ?? null);
    if (data.every((v) => v === null)) return;
    records.push({ id, recordType: "Measurement", subject, type, unit,
      sampleArray: { offsets, dataPoints: data }, startTime: start, endTime: end, provenance: prov });
    measuredBy.push({ type: "measuredBy", ref: id });
  };
  scalarStream("gpx-hr", "heart_rate", "/min", (p) => p.hr);
  scalarStream("gpx-cadence", "cadence", "/min", (p) => p.cad);
  scalarStream("gpx-power", "power", "W", (p) => p.power);

  records.push({
    id: "gpx-session", recordType: "Session", subject,
    ...(trkName ? { name: trkName } : {}),
    ...(discipline ? { disciplines: [discipline] } : {}),
    intent: "train", startTime: start, endTime: end,
    provenance: prov, links: measuredBy,
    workUnits: [{
      id: "gpx-session-wu", recordType: "WorkUnit", scoring: "continuous",
      performance: { time: { absolute: { value: offsets[offsets.length - 1], unit: "s" } } },
    }],
    ...(Object.keys(gpxExt).length ? { extension: { gpx: gpxExt } } : {}),
  });
  return records;
}
