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
 *   bun run sync:sources
 */

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

export type SourceRow = {
  id: string;
  name: string;
  lang: string;
  baseUrl: string;
  extPkg: string;
  extName: string;
  extVersion: string;
  extVersionCode: number;
  nsfw: boolean;
};

const res = await fetch(INDEX_URL, { headers: { 'user-agent': 'yuzono-tracker/sync' } });
if (!res.ok) throw new Error(`index fetch failed: ${res.status} ${res.statusText}`);

const index = (await res.json()) as IndexEntry[];

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

const sorted = [...rows.values()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.lang.localeCompare(b.lang),
);

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

console.log(`extensions   ${index.length}`);
console.log(`sources      ${sorted.length}${duplicates ? ` (${duplicates} duplicate ids skipped)` : ''}`);
console.log(`nsfw         ${sorted.filter((s) => s.nsfw).length}`);
console.log(`languages    ${Object.keys(byLang).length}  ${topLangs}`);
console.log(`wrote        src/data/sources.json`);
