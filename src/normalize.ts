// The OpenBody §8.3 canonical normalization / equivalence procedure.
// Reduces a document (a record or array of records) to a sorted set of canonical
// record byte strings. Two documents are equivalent iff these sets are equal.
import { canonicalString, deepCanon, type Json } from "./canonical.js";

type Rec = Record<string, any>;

// Inline container fields by recordType (§5.1). Program.sessions are refs (not inlined);
// WorkUnit.repDetail are sub-objects (not records) — neither is flattened.
const CONTAINERS: Record<string, string[]> = {
  Session: ["blocks", "exercises", "workUnits"],
  Block: ["children"],
  Exercise: ["workUnits"],
};

// Metric-value fields and their §5.10 default units (null = dimensionless).
const METRIC_DEFAULT_UNIT: Record<string, string | null> = {
  reps: null, time: "s", rest: "s", distance: "m", energy: "kcal", velocity: "m/s", rangeOfMotion: "deg",
};
const PRESCRIPTION_METRICS = ["reps", "time", "distance", "energy", "rest"];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function isFixedPointWire(v: any): boolean {
  return v && typeof v === "object" && !Array.isArray(v)
    && "coefficient" in v && "exponent" in v && Object.keys(v).length === 2;
}

// Expand a scalar metric to {absolute:{value}}; strip a unit equal to the field default.
function expandMetric(field: string, v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v === "number" || isFixedPointWire(v)) return { absolute: { value: v } };
  if (typeof v === "object") {
    const def = METRIC_DEFAULT_UNIT[field];
    if (def) {
      if (v.absolute && v.absolute.unit === def) delete v.absolute.unit;
      if (v.range && v.range.unit === def) delete v.range.unit;
    }
  }
  return v;
}

function transformMetricsObj(obj: Rec | undefined): void {
  if (!obj) return;
  for (const f of PRESCRIPTION_METRICS) if (f in obj) obj[f] = expandMetric(f, obj[f]);
  if (obj.load && typeof obj.load === "object") {
    const load = obj.load;
    if (typeof load.value === "number" || isFixedPointWire(load.value)) {
      load.value = { absolute: { value: load.value } };
    } else if (load.value?.absolute) {
      if (load.value.absolute.unit !== undefined && load.unit === undefined) load.unit = load.value.absolute.unit;
      delete load.value.absolute.unit;
    }
  }
  // effortLoad values are plain numbers — number canon (deepCanon) handles them.
}

function transformRepDetail(arr: any[] | undefined): void {
  if (!Array.isArray(arr)) return;
  for (const rep of arr) for (const f of ["velocity", "rangeOfMotion"]) if (f in rep) rep[f] = expandMetric(f, rep[f]);
}

function foldExerciseRef(rec: Rec): void {
  if (rec.exerciseRef === undefined) return;
  let er = rec.exerciseRef;
  if (typeof er === "string") er = { id: er };
  if (er && typeof er === "object" && typeof er.id === "string" && er.id.startsWith("openbody:")) {
    er.id = er.id.slice("openbody:".length);
  }
  rec.exerciseRef = er;
}

function addPartOf(rec: Rec, parentId: string): void {
  rec.links = rec.links || [];
  if (!rec.links.some((l: any) => l?.type === "partOf" && l.ref === parentId)) {
    rec.links.push({ type: "partOf", ref: parentId });
  }
}

// §8.3 step 5: expand `sets:N` into N WorkUnits (1st keeps id+position; rest id-less, after).
function expandSets(arr: any[]): any[] {
  const out: any[] = [];
  for (const item of arr) {
    const p = item?.recordType === "WorkUnit" ? item.prescription : undefined;
    const n = p && typeof p.sets === "number" ? p.sets : undefined;
    if (n && n >= 1) {
      if (item.performance !== undefined) throw new Error(`WorkUnit ${item.id ?? "?"}: sets+performance is invalid (§5.5)`);
      const first = clone(item); delete first.prescription.sets; out.push(first);
      for (let i = 1; i < n; i++) { const c = clone(item); delete c.prescription.sets; delete c.id; out.push(c); }
    } else {
      out.push(item);
    }
  }
  return out;
}

interface Ctx { subject?: string; startTime?: string; endTime?: string }

function flatten(rec: Rec, ctx: Ctx, out: Rec[]): void {
  // Tombstone: only id/recordType/status; no transforms (§7.1/§7.5).
  if (rec.status === "deleted") { out.push(rec); return; }

  // Propagate subject + timing (nearest ancestor wins; explicit child value wins).
  if (rec.subject === undefined && ctx.subject !== undefined) rec.subject = ctx.subject;
  if (rec.startTime === undefined && ctx.startTime !== undefined) rec.startTime = ctx.startTime;
  if (rec.endTime === undefined && ctx.endTime !== undefined) rec.endTime = ctx.endTime;

  if (rec.status === undefined) rec.status = "active";

  foldExerciseRef(rec);
  transformMetricsObj(rec.prescription);
  transformMetricsObj(rec.performance);
  transformRepDetail(rec.repDetail);
  if (rec.recordType === "Block" && rec.performance && "time" in rec.performance) {
    rec.performance.time = expandMetric("time", rec.performance.time);
  }

  const childCtx: Ctx = { subject: rec.subject, startTime: rec.startTime, endTime: rec.endTime };
  for (const field of CONTAINERS[rec.recordType] || []) {
    if (!Array.isArray(rec[field])) continue;
    const arr = expandSets(rec[field]);
    arr.forEach((child, i) => {
      if (child.id === undefined) child.id = `${rec.id}#${field}#${i + 1}`;
      addPartOf(child, rec.id);
      flatten(child, childCtx, out);
    });
    delete rec[field];
  }
  out.push(rec);
}

/** Normalize a document to a sorted array of canonical record byte strings. */
export function normalizeDocument(doc: Json): string[] {
  const inputs = Array.isArray(doc) ? doc : [doc];
  const flat: Rec[] = [];
  for (const rec of inputs) flatten(clone(rec) as Rec, {}, flat);
  return flat.map((r) => canonicalString(deepCanon(r as Json))).sort();
}

/** True iff two documents normalize to the same set of canonical records (§8.3). */
export function equivalent(a: Json, b: Json): boolean {
  const na = normalizeDocument(a);
  const nb = normalizeDocument(b);
  return na.length === nb.length && na.every((s, i) => s === nb[i]);
}
