// Minimal namespace-tolerant XML helpers shared by the regex-XML mappers
// (apple-health.ts, gpx.ts, tcx.ts). No DOMParser, no node deps — regex extraction
// over the raw XML string keeps every mapper browser-safe AND node-safe with zero
// dependencies. Element matching is namespace-prefix tolerant (<gpxtpx:hr>,
// <ns3:hr>, and <hr> all match) — these mappers never look at namespaces, which is
// also what makes e.g. GPX 1.0 parse identically to 1.1 (same element names, only
// the xmlns differs).
//
// Internal mapper plumbing, deliberately NOT re-exported from the package entry
// (src/index.ts) — implementation details, not public API.

const NAME = "[A-Za-z_][\\w.-]*";

// The five XML predefined entities (an XML 1.0 document can define no others without
// a DTD, which none of these export formats carry) + numeric character references.
const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Decode XML entities in extracted text/attribute values (reviewer C8: without this,
 * "Tom &amp; Jerry" survives encoded in names/notes). Single pass, so "&amp;lt;"
 * correctly decodes to the literal "&lt;", not "<".
 */
export const decodeEntities = (s: string): string =>
  s.includes("&")
    ? s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (all, hex, dec, name) => {
        if (name !== undefined) return ENTITY[name] ?? all;
        try {
          return String.fromCodePoint(Number.parseInt(hex ?? dec, hex !== undefined ? 16 : 10));
        } catch {
          return all; // out-of-range code point: leave the reference as written
        }
      })
    : s;

/** Global regex matching `<tag …>inner</tag>` or self-closing `<tag …/>`, any namespace prefix. */
export const elRe = (tag: string) =>
  new RegExp(`<(?:${NAME}:)?${tag}((?:\\s[^>]*?)?)(?:/>|>([\\s\\S]*?)</(?:${NAME}:)?${tag}\\s*>)`, "g");

export interface El {
  attrs: Record<string, string>;
  inner: string;
}

/** Every `tag` element in `xml` (attributes parsed + entity-decoded, raw inner markup preserved). */
export function* els(xml: string, tag: string): Generator<El> {
  for (const m of xml.matchAll(elRe(tag)))
    yield {
      attrs: Object.fromEntries(
        [...(m[1] ?? "").matchAll(/([\w:.-]+)="([^"]*)"/g)].map((a) => [a[1], decodeEntities(a[2] ?? "")]),
      ),
      inner: m[2] ?? "",
    };
}

export const first = (xml: string, tag: string): El | undefined => els(xml, tag).next().value;

/** Trimmed, entity-decoded text content of the first `tag` element (undefined when absent or empty). */
export const text = (xml: string, tag: string): string | undefined => {
  const t = first(xml, tag)?.inner.trim();
  return t ? decodeEntities(t) : undefined;
};

export const numText = (xml: string, tag: string): number | undefined => {
  const t = text(xml, tag);
  return t == null ? undefined : Number(t);
};
