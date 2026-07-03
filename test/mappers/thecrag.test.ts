// theCrag logbook mapper tests (OB-81): date+crag session grouping, the documented
// Ascent Type → outcome table, Gear Style → exerciseRef ladder, grade-as-modifier,
// route name in notes, and registry-backed ids. Ported from
// scripts/test-concept2-thecrag.ts.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { mapTheCrag } from "../../src/mappers/thecrag.js";
import {
  collectExerciseRefIds,
  expectValidAndStable,
  haveRegistry,
  readExample,
  registryExercisesPath,
} from "../helpers.js";

const crag = mapTheCrag(readExample("thecrag/thecrag-sample.csv"));
const wus = crag.flatMap((s) => s.workUnits ?? []);
const byRoute = (name: string) => wus.find((w) => typeof w.notes === "string" && w.notes.startsWith(name));

describe("mapTheCrag", () => {
  it("maps the sample logbook to valid, round-trip-stable wire records", () => {
    expectValidAndStable(crag);
    expect(crag, "expected 2 sessions (2 date+crag groups)").toHaveLength(2);
  });

  // The documented Ascent Type → outcome table (canonical corpus encoding:
  // climbing-send-attempt.valid.json / §5.18).
  const expectOutcome = (
    route: string,
    value: boolean | undefined,
    attempts: { made: number; attempted: number } | undefined,
  ) => {
    const wu = byRoute(route);
    expect(wu, `${route}: no WorkUnit found (route name must lead the notes)`).toBeDefined();
    const o = wu?.performance?.outcome;
    if (value === undefined) {
      expect(o, `${route}: expected no outcome`).toBeUndefined();
      return;
    }
    expect(o?.kind, route).toBe("success");
    expect(o?.value, route).toBe(value);
    expect(o?.attempts, `${route}: attempts`).toEqual(attempts);
  };

  it("onsight/flash ⇒ success on the first try (attempts 1/1)", () => {
    expectOutcome("The Bard", true, { made: 1, attempted: 1 });
    expectOutcome("Sleepy Hollow", true, { made: 1, attempted: 1 });
  });
  it("red point / send / top-rope clean / second clean ⇒ success, prior tries unknown", () => {
    expectOutcome("Kachoong", true, undefined);
    expectOutcome("Cave Man", true, undefined);
    expectOutcome("Muldoon", true, undefined);
    expectOutcome("Tiptoe Ridge", true, undefined);
  });
  it("attempt / hang dog / dab ⇒ not sent (made 0 of 1)", () => {
    expectOutcome("Punks in the Gym", false, { made: 0, attempted: 1 });
    expectOutcome("India", false, { made: 0, attempted: 1 });
    expectOutcome("Wheel of Life", false, { made: 0, attempted: 1 });
    expectOutcome("Rock Ape", false, { made: 0, attempted: 1 });
  });

  it("gear style (+ ascent type) picks the climb.* exerciseRef", () => {
    const expectRef = (route: string, id: string) => {
      expect(byRoute(route)?.exerciseRef?.id, route).toBe(id);
    };
    expectRef("The Bard", "climb.route.lead"); // Trad, led
    expectRef("Kachoong", "climb.route.lead"); // Sport, led
    expectRef("Muldoon", "climb.route.top-rope"); // Ascent Gear Style "Top rope"
    expectRef("Tiptoe Ridge", "climb.route.top-rope"); // "Second clean" follows on the rope
    expectRef("Cave Man", "climb.boulder");
  });

  // Canonical corpus encoding details: reps-scored, reps 1, grade as a modifiers token.
  it("encodes every ascent as a reps-scored single-try unit with grade modifier", () => {
    for (const w of wus) {
      expect(w.scoring, w.id).toBe("reps");
      expect(w.performance?.reps, w.id).toBe(1);
    }
    expect(byRoute("Wheel of Life")?.performance?.modifiers, "Ascent Grade must win over Route Grade").toEqual([
      { type: "grade", value: "V10" },
    ]);
    expect(byRoute("Kachoong")?.notes, "comment not carried into notes").toContain("Finally!");
  });

  it("groups by date + crag with honest disciplines and TZ-safe dates", () => {
    const day1 = crag.find((s) => s.name === "Arapiles");
    const day2 = crag.find((s) => s.name === "Hollow Mountain Cave");
    expect(day1?.startTime, "an offset-carrying Ascent Date must pass through untouched by the host TZ").toBe(
      "2026-05-16T00:00:00Z",
    );
    expect(day1?.disciplines).toEqual(["climbing"]);
    expect(day2?.disciplines).toEqual(["bouldering"]);
    expect(day1?.workUnits).toHaveLength(6);
    expect(day2?.workUnits).toHaveLength(4);
  });

  it.skipIf(!haveRegistry)("every canonical exerciseRef id exists in the registry", () => {
    const known = new Set(
      (JSON.parse(fs.readFileSync(registryExercisesPath, "utf8")) as { id: string }[]).map((e) => e.id),
    );
    const ids = collectExerciseRefIds(crag);
    expect(
      [...ids].some((i) => i.startsWith("climb.")),
      "no climb.* ids emitted at all",
    ).toBe(true);
    for (const id of ids) expect(known.has(id), `exerciseRef id "${id}" not in the registry`).toBe(true);
  });

  describe("malformed input (behavior pinned)", () => {
    it("empty input maps to []", () => {
      expect(mapTheCrag("")).toEqual([]);
    });
    it("rows missing the expected columns do not throw (one degraded session out)", () => {
      const out = mapTheCrag("a,b\n1,2");
      expect(out).toHaveLength(1);
      expect(out[0]?.recordType).toBe("Session");
      expect(out[0]?.startTime).toBeUndefined(); // no Ascent Date column
    });
  });
});
