// theCrag (thecrag.com) logbook CSV export → OpenBody Session/WorkUnit records
// (one Session per date + crag; one reps-scored WorkUnit per ascent).
//
// Format sources — built against the publicly documented export format; verify with a real
// export (OB-81 acceptance):
//   - Export path: Logbook → 'Action → Export logbook as CSV'
//     (https://www.thecrag.com/en/article/exportlogbook; also served at
//     /climber/<username>/logbook-csv). Header verified against a real export published in
//     https://github.com/AlbertSuarez/climbing (data/logbook.csv):
//     Route Name,Ascent Label,Ascent ID,Ascent Link,Ascent Type,Route Grade,Ascent Grade,
//     Route Gear Style,Ascent Gear Style,Route Height,Ascent Height,# Ascents,Route Stars,
//     Route ID,Route Link,Country,Country Link,Crag Name,Crag Link,Crag Path,With,Comment,
//     Quality,Ascent Date,Log Date,Shot
//   - Ascent-type and gear-style vocabularies: https://www.thecrag.com/en/article/ticktypes
//     and https://www.thecrag.com/en/article/styles, cross-checked against the serde enums
//     of a published theCrag CSV parser (https://github.com/musoke/open_tick,
//     src/thecrag.rs: gear styles Aid/Alpine/Boulder/Free solo/Second/Sport/Top rope/Trad/
//     Unknown; ascent types Onsight/Flash/Red point/Pink point/Greenpoint/Ground up red
//     point/Send/Tick/Clean/Repeat/Top rope (onsight|flash|clean|with rest)/Second (clean|
//     with rest)/Hang dog/Attempt/Working/Retreat/Dab/Mark/Ghost/Aid (solo)/Lead solo/
//     Roped Solo/Deep water solo).
//
// Encoding — follows the spec corpus's CANONICAL climbing encoding exactly
// (conformance/corpus/climbing-send-attempt.valid.json, §5.18): each ascent is a
// reps-scored WorkUnit whose grade is a `modifiers` token `{ type: "grade", value }` and
// whose result is `outcome { kind: "success", value, attempts { made, attempted } }`.
// `reps` = tries recorded by this row (theCrag logs one tick per row ⇒ 1); the route name
// (and the user's comment, when present) goes to `notes`; the raw ascent type / gear style
// ride losslessly in `extension.thecrag` (the outcome table below is deliberately lossy —
// Red point, Tick and Repeat all collapse to a clean success).
//
// Ascent Type → outcome table (documented per the deliverable):
//   | Ascent Type                                            | outcome.value | attempts        |
//   |--------------------------------------------------------|---------------|-----------------|
//   | Onsight, Flash, Top rope onsight, Top rope flash,      | true          | {made:1,        |
//   |   Greenpoint onsight                                   |  (first try)  |  attempted:1}   |
//   | Red point, Pink point, Greenpoint, Ground up red point,| true          | omitted (prior  |
//   |   Send, Tick, Clean, Repeat, Top rope, Top rope clean, |               |  tries unknown) |
//   |   Second, Second clean, Ghost, Lead solo, Roped Solo,  |               |                 |
//   |   Aid, Aid solo, Deep water solo                       |               |                 |
//   | Attempt, Working, Hang dog, Dog, Retreat, Dab,         | false         | {made:0,        |
//   |   Top rope with rest, Second with rest                 |               |  attempted:1}   |
//   | Mark (a project flag, not an ascent) / unknown types   | outcome omitted (raw type in  |
//   |                                                        |  extension.thecrag)           |
//
// Gear Style (+ Ascent Type) → exerciseRef (ids verified in the registry):
//   - Boulder ⇒ `climb.boulder`
//   - top-rope family (gear style Top rope/Second, or an ascent type of the Top rope…/
//     Second…/Ghost families) ⇒ `climb.route.top-rope`
//   - Sport / Trad (led) ⇒ `climb.route.lead`
//   - other known roped/route styles (Aid, Alpine, Free solo, Deep water solo…) ⇒ `climb`
//     (the registry's generic climbing id)
//   - blank/unknown ⇒ opaque-only
//   The raw gear style always rides in `exerciseRef.opaque` (§6.5 lossless floor);
//   `Ascent Gear Style` (as climbed) wins over `Route Gear Style`.
import { parseCsv, toRfc3339 } from "./csv.js";
import type { OpenBodyRecord, MapOptions } from "../types.js";

const FIRST_TRY = new Set(["onsight", "flash", "top rope onsight", "top rope flash", "greenpoint onsight"]);
const CLEAN = new Set([
  "red point", "pink point", "greenpoint", "ground up red point", "send", "tick", "clean", "repeat",
  "top rope", "top rope clean", "second", "second clean", "ghost", "lead solo", "roped solo",
  "aid", "aid solo", "deep water solo",
]);
const NOT_SENT = new Set(["attempt", "working", "hang dog", "dog", "retreat", "dab", "top rope with rest", "second with rest"]);

const TOP_ROPE_TYPES = /^(top rope|second|ghost)\b/;
const GENERIC_ROUTE_STYLES = new Set(["aid", "alpine", "free solo", "deep water solo", "ice", "mixed"]);

function exerciseRefFor(gearStyle: string, ascentType: string): OpenBodyRecord {
  const g = gearStyle.toLowerCase(), t = ascentType.toLowerCase();
  const opaque = gearStyle || ascentType || "climb";
  if (g === "boulder") return { id: "climb.boulder", opaque };
  if (g === "top rope" || g === "second" || TOP_ROPE_TYPES.test(t)) return { id: "climb.route.top-rope", opaque };
  if (g === "sport" || g === "trad") return { id: "climb.route.lead", opaque };
  if (GENERIC_ROUTE_STYLES.has(g)) return { id: "climb", opaque };
  return { opaque };
}

function outcomeFor(ascentType: string): OpenBodyRecord | undefined {
  const t = ascentType.toLowerCase();
  if (FIRST_TRY.has(t)) return { kind: "success", value: true, attempts: { made: 1, attempted: 1 } };
  if (CLEAN.has(t)) return { kind: "success", value: true };
  if (NOT_SENT.has(t)) return { kind: "success", value: false, attempts: { made: 0, attempted: 1 } };
  return undefined; // Mark / unknown: not an ascent result — raw type preserved in extension
}

/** Map a theCrag logbook CSV export to OpenBody wire records (one Session per date+crag). */
export function mapTheCrag(csv: string, opts: MapOptions = {}): OpenBodyRecord[] {
  const subject = opts.subject ?? "subj-001";
  const rows = parseCsv(csv);

  // Group ascents into Sessions by calendar date + crag (a theCrag logbook has no session
  // concept of its own — a day at one crag is the natural training occurrence).
  const sessions = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const date = (r["Ascent Date"] || r["Log Date"] || "").slice(0, 10);
    const k = `${date}|${r["Crag Name"] ?? ""}`;
    sessions.set(k, [...(sessions.get(k) ?? []), r]);
  }

  const records: OpenBodyRecord[] = [];
  let sIdx = 0;
  for (const [, srows] of sessions) {
    sIdx++;
    const sid = `thecrag-sess-${sIdx}`;
    const f = srows[0];
    if (f === undefined) continue; // unreachable: groups are created non-empty

    const disciplines: string[] = [];
    for (const r of srows) {
      const gear = (r["Ascent Gear Style"] || r["Route Gear Style"] || "").toLowerCase();
      const d = gear === "boulder" ? "bouldering" : "climbing";
      if (!disciplines.includes(d)) disciplines.push(d);
    }

    const workUnits = srows.map((r, j) => {
      const gearStyle = r["Ascent Gear Style"] || r["Route Gear Style"] || "";
      const ascentType = r["Ascent Type"] ?? "";
      const grade = r["Ascent Grade"] || r["Route Grade"] || "";
      const outcome = outcomeFor(ascentType);

      const performance: OpenBodyRecord = { reps: 1 };
      if (grade) performance.modifiers = [{ type: "grade", value: grade }];
      if (outcome) performance.outcome = outcome;

      const wu: OpenBodyRecord = {
        id: r["Ascent ID"] ? `${sid}-a${r["Ascent ID"]}` : `${sid}-a${j + 1}`,
        recordType: "WorkUnit",
        ...(r["Ascent ID"] ? { clientRecordId: r["Ascent ID"] } : {}),
        exerciseRef: exerciseRefFor(gearStyle, ascentType),
        scoring: "reps",
        ...(r["Route Name"] ? { notes: r["Comment"] ? `${r["Route Name"]}: ${r["Comment"]}` : r["Route Name"] } : {}),
        performance,
        extension: { thecrag: { ...(ascentType ? { ascentType } : {}), ...(gearStyle ? { gearStyle } : {}) } },
      };
      return wu;
    });

    // Ascent Date is usually already RFC 3339 (passes through); date-only/wall-clock forms
    // get opts.utcOffset stamped rather than the host TZ's interpretation.
    const startTime = f["Ascent Date"] ? toRfc3339(f["Ascent Date"], opts.utcOffset) : undefined;
    records.push({
      id: sid, recordType: "Session", subject,
      ...(f["Crag Name"] ? { name: f["Crag Name"] } : {}),
      disciplines,
      ...(startTime ? { startTime } : {}),
      provenance: { method: "manual", sourceApp: "thecrag" },
      ...(f["Crag Path"] || f["Country"]
        ? { extension: { thecrag: { ...(f["Crag Path"] ? { cragPath: f["Crag Path"] } : {}), ...(f["Country"] ? { country: f["Country"] } : {}) } } }
        : {}),
      workUnits,
    });
  }
  return records;
}
