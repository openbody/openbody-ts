// GPX + TCX mapper tests (OB-79): map the schema-built samples → wire records,
// schema-validate every record, assert offsets/channel shapes, HR values, lap→WorkUnit
// mapping, measuredBy links, and the degenerate cases (untimed GPX, waypoint-only GPX,
// Activities-less TCX). Self-contained — deliberately does NOT touch test-mappers.ts.
// Run: npx tsx scripts/test-tcx-gpx.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/schema-loader-node.js";
import { normalizeDocument } from "../src/normalize.js";
import { mapGpx } from "../src/mappers/gpx.js";
import { mapTcx } from "../src/mappers/tcx.js";

const ex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples");
const read = (p: string) => fs.readFileSync(path.join(ex, p), "utf8");
const j = (v: unknown) => JSON.stringify(v);

let total = 0, fail = 0;
function check(name: string, okDetail: string, run: (errs: string[]) => void) {
  total++;
  const errs: string[] = [];
  run(errs);
  if (errs.length) { fail++; console.log(`  FAIL ${name}\n${errs.map((e) => "       - " + e).join("\n")}`); }
  else console.log(`  ok   ${name} — ${okDetail}`);
}
// Every record must validate + normalization must round-trip (same bar as test-mappers.ts).
function validateAll(records: Record<string, any>[], errs: string[]) {
  for (const r of records) {
    const v = validate(r);
    if (!v.valid) errs.push(`wire ${r.recordType} ${r.id}: ${v.errors}`);
  }
  const n1 = normalizeDocument(records);
  const n2 = normalizeDocument(n1.map((s) => JSON.parse(s)));
  if (!(n1.length === n2.length && n1.every((s, i) => s === n2[i]))) errs.push("normalization not idempotent (round-trip)");
}

// ---------- GPX: timed two-segment track with TrackPointExtension hr/cad ----------
const gpx = mapGpx(read("gpx/gpx-sample.gpx"));
check("gpx timed track", `${gpx.length} wire records validate; 2 trkseg concatenate into 5-sample streams`, (errs) => {
  validateAll(gpx, errs);
  if (gpx.length !== 4) errs.push(`expected 4 records (route, hr, cadence, session), got ${gpx.length}: ${gpx.map((r) => r.id).join(",")}`);

  const route = gpx.find((r) => r.id === "gpx-route");
  const wantOffsets = [0, 5, 8, 98, 103]; // 18:37:26 +0/5/8, then segment 2 at +98/+103 — the pause stays honest
  if (j(route?.sampleArray?.offsets) !== j(wantOffsets)) errs.push(`route offsets: ${j(route?.sampleArray?.offsets)} (want ${j(wantOffsets)})`);
  if (j(route?.sampleArray?.channels?.map((c: any) => c.name)) !== j(["lat", "lon", "alt"])) errs.push(`route channels: ${j(route?.sampleArray?.channels)}`);
  if (route?.unit !== undefined) errs.push("multi-channel route must not carry a top-level unit");
  if (j(route?.sampleArray?.dataPoints?.[3]) !== j([47.6448, -122.3265, 7.1])) errs.push(`route point 3: ${j(route?.sampleArray?.dataPoints?.[3])}`);
  if (route?.sampleArray?.dataPoints?.[4]?.[2] !== null) errs.push("point without <ele> must have null alt");
  if (route?.startTime !== "2009-10-17T18:37:26Z" || route?.endTime !== "2009-10-17T18:39:09Z") errs.push(`route time span: ${route?.startTime}..${route?.endTime}`);

  const hr = gpx.find((r) => r.id === "gpx-hr");
  if (j(hr?.sampleArray?.dataPoints) !== j([128, 132, 135, 121, 124])) errs.push(`hr values: ${j(hr?.sampleArray?.dataPoints)}`);
  if (hr?.type !== "heart_rate" || hr?.unit !== "/min") errs.push(`hr type/unit: ${hr?.type}/${hr?.unit}`);
  if (j(hr?.sampleArray?.offsets) !== j(wantOffsets)) errs.push("hr must share the location offsets");

  const cad = gpx.find((r) => r.id === "gpx-cadence");
  if (j(cad?.sampleArray?.dataPoints) !== j([84, 86, 87, 82, null])) errs.push(`cadence values: ${j(cad?.sampleArray?.dataPoints)}`);

  const session = gpx.find((r) => r.recordType === "Session");
  if (j(session?.disciplines) !== j(["running"])) errs.push(`disciplines: ${j(session?.disciplines)}`);
  if (session?.name !== "Example GPX Document") errs.push(`session name: ${session?.name}`);
  const refs = (session?.links ?? []).filter((l: any) => l.type === "measuredBy").map((l: any) => l.ref);
  if (j(refs) !== j(["gpx-route", "gpx-hr", "gpx-cadence"])) errs.push(`measuredBy links: ${j(refs)}`);
  const wu = session?.workUnits?.[0];
  if (wu?.scoring !== "continuous" || j(wu?.performance?.time) !== j({ absolute: { value: 103, unit: "s" } })) errs.push(`session workUnit: ${j(wu)}`);
  if (session?.extension?.gpx?.creator !== "RunKeeper") errs.push(`creator not preserved: ${j(session?.extension)}`);
});

// ---------- GPX degenerate: track without <time> — no offsets representable ----------
const untimed = mapGpx(read("gpx/gpx-no-time-sample.gpx"));
check("gpx untimed track", "1 Session, no Measurements; geometry preserved in extension.gpx.untimedTrack", (errs) => {
  validateAll(untimed, errs);
  if (untimed.length !== 1 || untimed[0].recordType !== "Session") errs.push(`expected exactly 1 Session, got ${j(untimed.map((r) => r.recordType))}`);
  const s = untimed[0];
  if (s.startTime !== undefined || s.endTime !== undefined) errs.push("untimed session must not fabricate start/end times");
  if (j(s.disciplines) !== j(["hiking"])) errs.push(`disciplines: ${j(s.disciplines)}`);
  const track = s.extension?.gpx?.untimedTrack;
  if (track?.points?.length !== 3 || j(track?.points?.[0]) !== j([46.5784, 8.00654, 1932])) errs.push(`untimedTrack residue: ${j(track)}`);
});

// ---------- GPX degenerate: waypoint-only (GPX 1.0) — nothing subject-observed ----------
check("gpx waypoint-only (1.0)", "maps to [] gracefully (waypoints are map annotations, not telemetry)", (errs) => {
  const wpts = mapGpx(read("gpx/gpx-waypoints-sample.gpx"));
  if (wpts.length !== 0) errs.push(`expected [], got ${wpts.length} records: ${wpts.map((r) => r.id).join(",")}`);
});

// ---------- TCX: one Running activity, 2 laps, streams + lap aggregates ----------
const tcx = mapTcx(read("tcx/tcx-sample.tcx"));
check("tcx activity", `${tcx.length} wire records validate; laps → WorkUnits; 4 streams + 4 lap HR aggregates`, (errs) => {
  validateAll(tcx, errs);
  if (tcx.length !== 9) errs.push(`expected 9 records (route/hr/cadence/power + 4 aggregates + session), got ${tcx.length}: ${tcx.map((r) => r.id).join(",")}`);

  const session = tcx.find((r) => r.recordType === "Session");
  if (session?.id !== "tcx-1" || session?.clientRecordId !== "2010-06-26T10:06:11Z") errs.push(`session id/clientRecordId: ${session?.id}/${session?.clientRecordId}`);
  if (j(session?.disciplines) !== j(["running"])) errs.push(`Sport → discipline: ${j(session?.disciplines)}`);
  if (session?.startTime !== "2010-06-26T10:06:11Z" || session?.endTime !== "2010-06-26T10:06:41Z") errs.push(`session span: ${session?.startTime}..${session?.endTime}`);
  if (session?.provenance?.device?.model !== "Garmin Forerunner 305") errs.push(`Creator → device: ${j(session?.provenance)}`);

  // Lap → WorkUnit mapping (§5.1 collapsed hierarchy: Session.workUnits, no invented Block tier).
  const wus = session?.workUnits ?? [];
  if (wus.length !== 2) errs.push(`expected 2 lap WorkUnits, got ${wus.length}`);
  const lap1 = wus[0];
  if (lap1?.scoring !== "continuous" || lap1?.startTime !== "2010-06-26T10:06:11Z") errs.push(`lap 1 scoring/start: ${j(lap1)}`);
  if (j(lap1?.performance?.time) !== j({ absolute: { value: 15, unit: "s" } })) errs.push(`lap 1 time: ${j(lap1?.performance?.time)}`);
  if (j(lap1?.performance?.distance) !== j({ absolute: { value: 50, unit: "m" } })) errs.push(`lap 1 distance: ${j(lap1?.performance?.distance)}`);
  if (j(lap1?.performance?.energy) !== j({ absolute: { value: 4, unit: "kcal" } })) errs.push(`lap 1 calories: ${j(lap1?.performance?.energy)}`);
  if (lap1?.setRole !== undefined) errs.push(`Active lap must not carry a setRole: ${lap1?.setRole}`);
  if (wus[1]?.setRole !== "tcx:resting") errs.push(`Resting lap setRole: ${wus[1]?.setRole}`);

  // Streams: offsets from trackpoint Times, laps concatenated (incl. the 10 s gap).
  const wantOffsets = [0, 5, 10, 15, 20, 30];
  const hr = tcx.find((r) => r.id === "tcx-1-hr");
  if (j(hr?.sampleArray?.offsets) !== j(wantOffsets)) errs.push(`hr offsets: ${j(hr?.sampleArray?.offsets)}`);
  if (j(hr?.sampleArray?.dataPoints) !== j([128, 133, 138, 145, 150, 148])) errs.push(`hr values: ${j(hr?.sampleArray?.dataPoints)}`);
  const route = tcx.find((r) => r.id === "tcx-1-route");
  if (j(route?.sampleArray?.channels?.map((c: any) => c.name)) !== j(["lat", "lon", "alt"])) errs.push(`route channels: ${j(route?.sampleArray?.channels)}`);
  if (j(route?.sampleArray?.dataPoints?.[4]) !== j([null, null, 4.1])) errs.push(`GPS-dropout point must null lat/lon: ${j(route?.sampleArray?.dataPoints?.[4])}`);
  const watts = tcx.find((r) => r.id === "tcx-1-power");
  if (j(watts?.sampleArray?.dataPoints) !== j([245, 252, 258, 260, null, 241])) errs.push(`ns3:TPX Watts: ${j(watts?.sampleArray?.dataPoints)}`);

  const refs = (session?.links ?? []).filter((l: any) => l.type === "measuredBy").map((l: any) => l.ref);
  if (j(refs) !== j(["tcx-1-route", "tcx-1-hr", "tcx-1-cadence", "tcx-1-power"])) errs.push(`measuredBy links: ${j(refs)}`);

  // Lap Average/MaximumHeartRateBpm → interval aggregates with derivedFrom → the HR stream.
  const mean1 = tcx.find((r) => r.id === "tcx-1-lap-1-hr-mean");
  if (mean1?.quantity !== 133 || mean1?.type !== "heart_rate_mean") errs.push(`lap 1 hr mean: ${j(mean1)}`);
  if (mean1?.startTime !== "2010-06-26T10:06:11Z" || mean1?.endTime !== "2010-06-26T10:06:26Z") errs.push(`lap 1 aggregate window: ${mean1?.startTime}..${mean1?.endTime}`);
  if (!mean1?.links?.some((l: any) => l.type === "derivedFrom" && l.ref === "tcx-1-hr")) errs.push("lap aggregate missing derivedFrom → hr stream");
  if (mean1?.provenance?.algorithm?.name == null) errs.push("derived aggregate should name its algorithm (§7.4)");
  const max2 = tcx.find((r) => r.id === "tcx-1-lap-2-hr-max");
  if (max2?.quantity !== 150) errs.push(`lap 2 hr max: ${j(max2)}`);
});

// ---------- TCX degenerate: no <Activities> (Courses-only file) ----------
check("tcx courses-only", "maps to [] gracefully (Courses/Workouts documented unsupported)", (errs) => {
  const coursesOnly = `<?xml version="1.0"?>
    <TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
      <Courses><Course><Name>Loop</Name>
        <Lap><TotalTimeSeconds>600</TotalTimeSeconds><DistanceMeters>2000</DistanceMeters>
          <BeginPosition><LatitudeDegrees>52.1</LatitudeDegrees><LongitudeDegrees>4.4</LongitudeDegrees></BeginPosition>
          <EndPosition><LatitudeDegrees>52.2</LatitudeDegrees><LongitudeDegrees>4.5</LongitudeDegrees></EndPosition>
          <Intensity>Active</Intensity>
        </Lap>
      </Course></Courses>
    </TrainingCenterDatabase>`;
  const out = mapTcx(coursesOnly);
  if (out.length !== 0) errs.push(`expected [], got ${out.length} records: ${out.map((r) => r.id).join(",")}`);
});

console.log(`\n${total - fail}/${total} tcx/gpx checks pass`);
if (fail) process.exit(1);
