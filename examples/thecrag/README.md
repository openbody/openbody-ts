# Breadth proof: theCrag logbook (climbing) → OpenBody

`map-thecrag.ts` maps a theCrag **logbook CSV export** (`thecrag-sample.csv`) into
OpenBody, validates the wire records against the JSON Schema, and normalizes them.
The sample is **constructed** to the publicly documented export format — header
verified against a real export published in
[AlbertSuarez/climbing](https://github.com/AlbertSuarez/climbing/blob/master/data/logbook.csv)
and the vocabularies in theCrag's
[export](https://www.thecrag.com/en/article/exportlogbook) /
[tick types](https://www.thecrag.com/en/article/ticktypes) /
[gear styles](https://www.thecrag.com/en/article/styles) help pages — **built against
the publicly documented export format; verify with a real export (OB-81 acceptance)**.

Run: `npx tsx examples/thecrag/map-thecrag.ts`

## theCrag column → OpenBody mapping

| theCrag column | OpenBody |
|---|---|
| rows grouped by `Ascent Date` + `Crag Name` | one `Session` per date+crag (`name` = crag, `Crag Path`/`Country` → `extension.thecrag`) |
| one ascent row | one `reps`-scored `WorkUnit` (`reps: 1` — the tick this row records), per the spec corpus's canonical climbing encoding (`climbing-send-attempt.valid.json`, §5.18) |
| `Ascent Gear Style` (falls back to `Route Gear Style`) | `exerciseRef`: Boulder → `climb.boulder`; Top rope/Second family → `climb.route.top-rope`; Sport/Trad led → `climb.route.lead`; Aid/Alpine/solo styles → `climb`; unknown → opaque. Raw style kept in `opaque`. Boulder rows also flip the session discipline to `bouldering`. |
| `Ascent Type` | `performance.outcome`: Onsight/Flash → `{ kind: success, value: true, attempts: { made: 1, attempted: 1 } }`; Red point/Send/Tick/… → `{ kind: success, value: true }` (prior tries unknown); Attempt/Hang dog/Dab/… → `{ kind: success, value: false, attempts: { made: 0, attempted: 1 } }`. Full table in `src/mappers/thecrag.ts`. Raw type kept in `extension.thecrag`. |
| `Ascent Grade` (falls back to `Route Grade`) | `modifiers: [{ type: "grade", value }]` (the corpus's grade encoding — not a new field) |
| `Route Name` (+ `Comment`) | `WorkUnit.notes` |
| `Ascent ID` | `clientRecordId` |
