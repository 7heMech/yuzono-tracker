import type { APIRoute } from 'astro';
import { SOURCES, langLabel, sourcePath } from '../lib/sources';

/**
 * The live source catalogue as a build-time static file, for SourceFinder.
 *
 * It used to travel as hydration props: the whole catalogue serialised into
 * the island's props attribute on `/`, `/sources/` and `/new`, HTML-escaped,
 * parsed on every visit whether or not anyone typed in the box. Measured, that
 * was 31,059 bytes of JSON inflated to 59,799 by escaping — 5,750 `&quot;`
 * sequences — 8,401 bytes gzipped on the critical path of three pages.
 *
 * Here it is one file, fetched once, lazily, on first focus of the input.
 *
 * `prerender = true` is the point of the file. Workers Assets serves it, so the
 * Worker is never invoked for it and nothing is serialised per request; making
 * it on-demand would put the catalogue build back on the request path and cost
 * an invocation for a payload that never changes between deploys.
 *
 * The shape is positional rather than an array of objects, which is not
 * micro-optimising at this row count: the repeated key names were most of the
 * bytes. 14,366 bytes / 4,034 gzipped, against 29,248 / 5,106 for the same
 * fields written as objects.
 *
 *   l — language labels, referenced by index. 38 labels across the catalogue,
 *       so storing the label per row instead would repeat "Portuguese" 40
 *       times. These are labels, not codes: the finder only ever displays
 *       them, and resolving them here means langLabel() runs 38 times at build
 *       rather than once per row in every visitor's browser.
 *   s — [name, path, langIndex, nsfw ? 1 : 0, extName?]. extName is present
 *       only on the sources where it differs from the name; the rest would be
 *       storing the same string twice.
 *
 * `path` is the finished URL from sourcePath(), not the slug. The client must
 * not be in the business of building that string: the trailing slash is what
 * stops a prerendered directory costing a 307 first, and this is the only file
 * that would have had to remember it.
 */
export const prerender = true;

export const GET: APIRoute = () => {
  const labels: string[] = [];
  const labelIndex = new Map<string, number>();
  const langRef = (code: string) => {
    const label = langLabel(code);
    let at = labelIndex.get(label);
    if (at === undefined) {
      at = labels.push(label) - 1;
      labelIndex.set(label, at);
    }
    return at;
  };

  // Catalogue order is preserved. The finder ranks prefix matches ahead of
  // substring matches and stops at eight, so the order it iterates in decides
  // which eight a two-letter query shows.
  const sources = SOURCES.map((s) => {
    const row: (string | number)[] = [s.name, sourcePath(s), langRef(s.lang), s.nsfw ? 1 : 0];
    if (s.extName !== s.name) row.push(s.extName);
    return row;
  });

  return new Response(JSON.stringify({ l: labels, s: sources }), {
    // No cache headers: this builds to dist/sources.json and Workers Assets
    // decides its own caching. Setting them here would be dead code.
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
