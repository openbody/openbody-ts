// The OpenBody §8.3 canonical normalization / equivalence procedure.
// Reduces a document (a record or array of records) to a sorted set of canonical
// record byte strings. Two documents are equivalent iff these sets are equal.
import { canonicalString, deepCanon, type Json } from "./canonical.js";
import { LosslessNumber } from "./parse.js";

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

// §5.8 primary metric per WorkUnit.scoring kind (continuous has none → skipped).
const SCORING_PRIMARY_METRIC: Record<string, string> = {
  reps: "reps", time: "time", distance: "distance", energy: "energy",
};

// Deep clone that preserves LosslessNumber instances (a plain JSON round-trip would
// destroy them). LosslessNumber is immutable, so the same instance can be shared.
function clone<T>(x: T): T {
  if (x instanceof LosslessNumber) return x;
  if (Array.isArray(x)) return x.map(clone) as unknown as T;
  if (x && typeof x === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(x)) out[k] = clone(v);
    return out as T;
  }
  return x;
}

function isScalarNumber(v: any): boolean {
  return typeof v === "number" || v instanceof LosslessNumber || isFixedPointWire(v);
}

function isFixedPointWire(v: any): boolean {
  return v && typeof v === "object" && !Array.isArray(v)
    && "coefficient" in v && "exponent" in v && Object.keys(v).length === 2;
}

// Expand a scalar metric to {absolute:{value}}; strip a unit equal to the field default.
function expandMetric(field: string, v: any): any {
  if (v === null || v === undefined) return v;
  if (isScalarNumber(v)) return { absolute: { value: v } };
  if (typeof v === "object") {
    const def = METRIC_DEFAULT_UNIT[field];
    if (def) {
      if (v.absolute && v.absolute.unit === def) delete v.absolute.unit;
      if (v.range && v.range.unit === def) delete v.range.unit;
      // `ramp` is not a legal variant on these fields (§5.10 — restricted to
      // `load.value`/`Intensity.value`, handled separately below); no ramp handling here.
    }
  }
  return v;
}

function transformMetricsObj(obj: Rec | undefined): void {
  if (!obj) return;
  for (const f of PRESCRIPTION_METRICS) if (f in obj) obj[f] = expandMetric(f, obj[f]);
  // `sides.restBetween` is scalar-or-Target with the same default unit ("s") as
  // `rest` (§5.5, §5.10) — reuse expandMetric under the "rest" default-unit key.
  if (obj.sides && typeof obj.sides === "object" && "restBetween" in obj.sides) {
    obj.sides.restBetween = expandMetric("rest", obj.sides.restBetween);
  }
  if (obj.load && typeof obj.load === "object") {
    const load = obj.load;
    if (isScalarNumber(load.value)) {
      load.value = { absolute: { value: load.value } };
    } else if (load.value?.absolute) {
      if (load.value.absolute.unit !== undefined && load.unit === undefined) load.unit = load.value.absolute.unit;
      delete load.value.absolute.unit;
    } else if (load.value?.range) {
      if (load.value.range.unit !== undefined && load.unit === undefined) load.unit = load.value.range.unit;
      delete load.value.range.unit;
    } else if (load.value?.ramp) {
      // Fold `ramp.unit` to the sibling `Load.unit`, mirroring the `absolute` case above —
      // `from`/`to` themselves are never touched (§5.10, order-significant).
      if (load.value.ramp.unit !== undefined && load.unit === undefined) load.unit = load.value.ramp.unit;
      delete load.value.ramp.unit;
    }
  }
  // Intensity entries carry a scalar-or-Target `value` with the unit on the sibling
  // (like Load); `zone` entries have no value. Mirror the Load expansion.
  if (Array.isArray(obj.intensity)) {
    for (const it of obj.intensity) {
      if (!it || typeof it !== "object") continue;
      if (isScalarNumber(it.value)) {
        it.value = { absolute: { value: it.value } };
      } else if (it.value?.absolute) {
        if (it.value.absolute.unit !== undefined && it.unit === undefined) it.unit = it.value.absolute.unit;
        delete it.value.absolute.unit;
      } else if (it.value?.range) {
        if (it.value.range.unit !== undefined && it.unit === undefined) it.unit = it.value.range.unit;
        delete it.value.range.unit;
      } else if (it.value?.ramp) {
        // Fold `ramp.unit` to the sibling `Intensity.unit`, mirroring absolute/range —
        // `from`/`to` are directional (§5.10) and are never reordered/touched here.
        if (it.value.ramp.unit !== undefined && it.unit === undefined) it.unit = it.value.ramp.unit;
        delete it.value.ramp.unit;
      }
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

// Recursively strip ids from a copied subtree (§8.3 step 5: roundScheme copies 2..n).
function stripIds(rec: Rec): void {
  delete rec.id;
  for (const field of CONTAINERS[rec?.recordType] || []) {
    if (Array.isArray(rec[field])) for (const c of rec[field]) stripIds(c);
  }
}

// Inject a round's value into each descendant WorkUnit whose primary metric is absent
// (§5.4/§5.8). Stops at a nested Block that carries its own roundScheme (it injects its
// own). The value lands in `prescription` — roundScheme is a planned shorthand.
function injectRoundMetric(rec: Rec, value: any): void {
  if (rec?.recordType === "WorkUnit") {
    const metric = SCORING_PRIMARY_METRIC[rec.scoring];
    if (metric) {
      const p = rec.prescription || (rec.prescription = {});
      if (p[metric] === undefined) p[metric] = value;
    }
  }
  for (const field of CONTAINERS[rec?.recordType] || []) {
    if (!Array.isArray(rec[field])) continue;
    for (const c of rec[field]) {
      if (c?.recordType === "Block" && c.roundScheme !== undefined) continue;
      injectRoundMetric(c, value);
    }
  }
}

// §8.3 step 5: expand `Block.roundScheme:[v1..vn]` into n in-order copies of `children`;
// copy r injects vr into ladder-following WorkUnits; copies 2..n are id-less.
function expandRoundScheme(block: Rec): void {
  const rs = block.roundScheme;
  if (rs === undefined) return;
  const where = block.id ?? "?";
  if (block.repetitions !== undefined) throw new Error(`Block ${where}: roundScheme+repetitions is invalid (§5.4)`);
  if (block.performance !== undefined) throw new Error(`Block ${where}: roundScheme+performance is invalid (§5.4)`);
  const src: any[] = Array.isArray(block.children) ? block.children : [];
  const out: any[] = [];
  rs.forEach((v: any, r: number) => {
    for (const child of src) {
      const c = clone(child);
      injectRoundMetric(c, v);
      if (r > 0) stripIds(c);
      out.push(c);
    }
  });
  block.children = out;
  delete block.roundScheme;
}

// §8.3 step 5: expand `sets:N` into N WorkUnits (1st keeps id+position; rest id-less, after).
function expandSets(arr: any[]): any[] {
  const out: any[] = [];
  for (const item of arr) {
    const p = item?.recordType === "WorkUnit" ? item.prescription : undefined;
    const raw = p ? p.sets : undefined;
    const n = raw instanceof LosslessNumber ? Number(raw.value)
      : typeof raw === "number" ? raw : undefined;
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

  if (rec.recordType === "Block") expandRoundScheme(rec);

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
