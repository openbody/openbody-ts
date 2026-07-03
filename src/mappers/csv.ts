// Internal mapper plumbing (quoted-CSV parsing, number/timestamp helpers, content
// hashing) shared by the CSV-based mappers. Deliberately NOT re-exported from the
// package entry (src/index.ts) — these are implementation details, not public API.
export function parseCsv(text: string, delim = ","): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (cell !== "" || row.length) { row.push(cell); rows.push(row); row = []; cell = ""; } if (c === "\r" && text[i + 1] === "\n") i++; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

export const num = (s: string | undefined): number | undefined => {
  if (s == null || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined; // a malformed cell must not put NaN on the wire
};

/** Short stable content hash (FNV-1a 32-bit, hex) for ids derived from record content —
 * positional numbering would shift on re-export, defeating §7.1 dedup. */
export function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const MONTH: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * RFC 3339 from the wall-clock date strings the CSV sources emit: "2026-03-02 06:45:00"
 * (Strong/Concept2), "22 Dec 2025, 08:00" (Hevy), bare "2026-03-02". These carry NO offset,
 * so the components are parsed manually and stamped with `utcOffset` (default "Z") — never
 * via `new Date(s)`, whose parsing of offset-less strings is host-timezone-dependent (the
 * mapped instant would change with the machine's TZ; fitbit.ts precedent). Strings that
 * already carry an offset (theCrag's RFC 3339 timestamps) pass through unchanged, as does
 * anything unrecognized (schema validation flags it downstream).
 */
export function toRfc3339(s: string, utcOffset = "Z"): string {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}${utcOffset}`;
  m = /^(\d{1,2}) ([A-Za-z]{3,}) (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m) {
    const [, day, monName, year, hh, mm, ss] = m;
    const mon = monName !== undefined ? MONTH[monName.slice(0, 3).toLowerCase()] : undefined;
    if (day !== undefined && year !== undefined && hh !== undefined && mm !== undefined && mon !== undefined) {
      return `${year}-${mon}-${day.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm}:${ss ?? "00"}${utcOffset}`;
    }
  }
  return t;
}
