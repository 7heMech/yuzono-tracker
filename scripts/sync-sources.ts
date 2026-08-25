/**
 * Flattens the published extension index into the static source catalogue the
 * site prerenders from.
 *
 * One extension can expose many sources (AnimeWorld India alone has dozens of
 * language variants), and reports target a *source*, not a package — so the
 * numeric source id is the join key everywhere in this app. It is also the id
 * the app itself shows users, which makes it the only value a reporter can
 * realistically be expected to match.
 *
 * Sources the index has dropped are kept as tombstones rather than deleted.
 * Reports hold a bare source_id, so deleting a row strips every report about
 * that source of its name, 404s its prerendered page, and freezes its nsfw
 * flag outside reconcileNsfw's reach. mergeCatalogue stamps the day on the row
 * instead; a source the index lists again comes back live with fresh fields.
 *
 *   bun run sync:sources
 */

import type { SourceRow } from '../src/lib/sources';

const INDEX_URL =
  'https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json';
const OUT = new URL('../src/data/sources.json', import.meta.url);

type IndexEntry = {
  name: string;
  pkg: string;
  apk: string;
  lang: string;
  code: number;
  version: string;
  nsfw: number;
  sources: { name: string; lang: string; id: string; baseUrl: string }[];
};

export function flatten(index: IndexEntry[]): { rows: SourceRow[]; duplicates: number } {
  const rows = new Map<string, SourceRow>();
  let duplicates = 0;

  for (const ext of index) {
    // Strip the app prefix the index uses for display ("Aniyomi: AnimeOnsen").
    const extName = ext.name.replace(/^\s*(Aniyomi|Anikku|Tachiyomi)\s*:\s*/i, '');

    for (const src of ext.sources ?? []) {
      if (rows.has(src.id)) {
        duplicates++;
        continue;
      }
      rows.set(src.id, {
        id: src.id,
        name: src.name,
        lang: src.lang || ext.lang,
        baseUrl: src.baseUrl,
        extPkg: ext.pkg,
        extName,
        extVersion: ext.version,
        extVersionCode: ext.code,
        nsfw: ext.nsfw === 1,
      });
    }
  }

  return { rows: [...rows.values()], duplicates };
}

/**
 * Upstream wins every field, so a returning id is reborn with the fresh name
 * and version and loses `removed`. An id upstream has dropped carries over as
 * a tombstone stamped with the day it was noticed gone — and the `??` keeps an
 * existing stamp, which is what stops this re-stamping on every five-minute
 * run and leaves the commit diff empty once nothing moved.
 */
export function mergeCatalogue(
  previous: SourceRow[],
  upstream: SourceRow[],
  today: string,
): SourceRow[] {
  const live = new Map(upstream.map((r) => [r.id, r]));
  const merged = new Map<string, SourceRow>();
  for (const row of upstream) merged.set(row.id, { ...row });
  for (const row of previous) {
    if (!live.has(row.id)) merged.set(row.id, { ...row, removed: row.removed ?? today });
  }
  return [...merged.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.lang.localeCompare(b.lang),
  );
}

if (import.meta.main) {
  const res = await fetch(INDEX_URL, { headers: { 'user-agent': 'yuzono-tracker/sync' } });
  if (!res.ok) throw new Error(`index fetch failed: ${res.status} ${res.statusText}`);

  const index = (await res.json()) as IndexEntry[];
  const { rows, duplicates } = flatten(index);

  let previous: SourceRow[] = [];
  try {
    previous = (await Bun.file(OUT).json()) as SourceRow[];
  } catch (err) {
    /* Only a missing file means "first run". A catalogue that exists but
       cannot be read or parsed must stop the sync: falling back to [] here
       would write an upstream-only file and silently drop every tombstone. */
    if ((err as { code?: string })?.code !== 'ENOENT') throw err;
  }

  const sorted = mergeCatalogue(previous, rows, new Date().toISOString().slice(0, 10));

  await Bun.write(OUT, JSON.stringify(sorted, null, 2) + '\n');

  const byLang = sorted.reduce<Record<string, number>>((acc, s) => {
    acc[s.lang] = (acc[s.lang] ?? 0) + 1;
    return acc;
  }, {});
  const topLangs = Object.entries(byLang)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([l, n]) => `${l}:${n}`)
    .join(' ');

  const liveIds = new Set(rows.map((r) => r.id));
  const gone = previous.filter((r) => !r.removed && !liveIds.has(r.id));

  console.log(`extensions   ${index.length}`);
  console.log(`sources      ${sorted.length}${duplicates ? ` (${duplicates} duplicate ids skipped)` : ''}`);
  console.log(`removed      ${gone.length}${gone.length ? ` (${gone.map((s) => s.name).join(', ')})` : ''}`);
  console.log(`nsfw         ${sorted.filter((s) => s.nsfw).length}`);
  console.log(`languages    ${Object.keys(byLang).length}  ${topLangs}`);
  console.log(`wrote        src/data/sources.json`);
}
