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

/** Global regex matching `<tag …>inner</tag>` or self-closing `<tag …/>`, any namespace prefix. */
export const elRe = (tag: string) =>
  new RegExp(`<(?:${NAME}:)?${tag}((?:\\s[^>]*?)?)(?:/>|>([\\s\\S]*?)</(?:${NAME}:)?${tag}\\s*>)`, "g");

export interface El {
  attrs: Record<string, string>;
  inner: string;
}

/** Every `tag` element in `xml` (attributes parsed, raw inner markup preserved). */
export function* els(xml: string, tag: string): Generator<El> {
  for (const m of xml.matchAll(elRe(tag)))
    yield {
      attrs: Object.fromEntries([...(m[1] ?? "").matchAll(/([\w:.-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
      inner: m[2] ?? "",
    };
}

export const first = (xml: string, tag: string): El | undefined => els(xml, tag).next().value;

/** Trimmed text content of the first `tag` element (undefined when absent or empty). */
export const text = (xml: string, tag: string): string | undefined => {
  const t = first(xml, tag)?.inner.trim();
  return t === "" ? undefined : t;
};

export const numText = (xml: string, tag: string): number | undefined => {
  const t = text(xml, tag);
  return t == null ? undefined : Number(t);
};
