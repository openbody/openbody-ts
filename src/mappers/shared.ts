// Cross-format mapper plumbing shared by the telemetry mappers (strava.ts, fit.ts,
// gpx.ts, tcx.ts, …). Internal, deliberately NOT re-exported from the package entry
// (src/index.ts) — implementation details, not public API.
import {
  DEFAULT_SUBJECT,
  type Link,
  type LiveRecord,
  type MapOptions,
  type MapWarning,
  type Provenance,
} from "../types.js";

/** RFC 3339 at whole-second precision — trims the ".000" that toISOString always emits. */
export const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Resolve the subject id every record gets stamped with. When `opts.subject` is
 * absent the shared placeholder DEFAULT_SUBJECT is used AND reported once on the
 * warnings channel (code "default-subject") — the fallback is a fabrication, and
 * per the WP7 policy (src/errors.ts) fabrications are never silent.
 */
export function subjectFor(opts: MapOptions, warnings: MapWarning[], mapper: string): string {
  if (opts.subject !== undefined) return opts.subject;
  warnings.push({
    code: "default-subject",
    message: `no MapOptions.subject provided — records carry the fabricated placeholder subject "${DEFAULT_SUBJECT}"; pass your own subject id`,
    context: { mapper, subject: DEFAULT_SUBJECT },
  });
  return DEFAULT_SUBJECT;
}

/**
 * The shared discipline-token mechanism (§4.4 open-token ladder): look a vendor
 * sport string up in the mapper's own token map (key sets are vendor-specific —
 * a Strava "Ride" and a GPX "ride" are different vocabularies, so every map stays
 * next to its mapper), falling back to a source-namespaced token. `fallbackToken`
 * lets a mapper normalize the fallback spelling differently from the lookup key
 * (e.g. gpx.ts looks up "trail_running" but falls back to "gpx:trail running").
 * apple-health.ts reuses the same mechanism for its HK quantity-type map.
 */
export function makeDisciplineMapper(map: Record<string, string>, namespace: string) {
  return (key: string, fallbackToken: string = key): string => map[key] ?? `${namespace}:${fallbackToken}`;
}

/** Everything a scalar sampleArray Measurement shares with its siblings from one recording. */
export interface ScalarStreamSink {
  /** Output array the Measurement record is pushed onto. */
  records: LiveRecord[];
  /** measuredBy link list (for the owning Session/WorkUnit) the `{ type: "measuredBy", ref: id }` entry is pushed onto (§7.2). */
  measuredBy: Link[];
  subject: string;
  offsets: number[];
  startTime: string | undefined;
  endTime: string | undefined;
  provenance: Provenance;
}

/**
 * Build the per-recording scalar-stream pusher: emits one single-channel sampleArray
 * Measurement (§4.3) sharing the recording's offsets/window/provenance, and records
 * the measuredBy link for the Session to pick up (§7.2).
 */
export function makeScalarStream(sink: ScalarStreamSink) {
  return (id: string, type: string, unit: string, dataPoints: (number | null)[]): void => {
    sink.records.push({
      id,
      recordType: "Measurement",
      subject: sink.subject,
      type,
      unit,
      sampleArray: { offsets: sink.offsets, dataPoints },
      startTime: sink.startTime,
      endTime: sink.endTime,
      provenance: sink.provenance,
    });
    sink.measuredBy.push({ type: "measuredBy", ref: id });
  };
}

/**
 * Pick one scalar channel out of a decoded sample list, null-padding gaps (§4.3
 * dataPoints are null-padded, never dropped). Returns undefined when every sample
 * is null — the source never carried this channel, so no stream should be emitted.
 */
export function pickSeries<T>(items: T[], pick: (item: T) => number | undefined): (number | null)[] | undefined {
  const data = items.map((item) => pick(item) ?? null);
  return data.every((v) => v === null) ? undefined : data;
}
