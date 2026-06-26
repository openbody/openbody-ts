// Minimal quoted-CSV parser shared by the CSV-based mappers (Hevy, Strong).
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

export const num = (s: string | undefined): number | undefined =>
  s == null || s === "" ? undefined : Number(s);

/** Best-effort RFC 3339 from a free-form date string (assumes UTC when no offset). */
export function toRfc3339(s: string): string {
  const d = new Date(s.replace(",", ""));
  return isNaN(d.getTime()) ? s : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type OpenBodyRecord = Record<string, any>;
export interface MapOptions { subject?: string }
