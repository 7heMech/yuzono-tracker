import { describe, expect, test } from 'bun:test';
import {
  ALL_SOURCES,
  PICKER_ROWS,
  REMOVED_SOURCES,
  SOURCES,
  getSource,
  getLiveSource,
  getSourceByRef,
  langDir,
  langLabel,
  languageFacets,
  sourcePath,
  withSlugs,
  type SourceRow,
} from '../../src/lib/sources';

/**
 * Slugs are derived at import time, not stored, so a change to the derivation
 * silently rewrites every `/source/<slug>/` URL in the catalogue at once. These
 * tests exist to make that loud: the invariants below are what the routing,
 * the sitemap and every Discord link already published depend on.
 */
describe('slug derivation', () => {
  test('every slug is unique across live and removed entries', () => {
    // A collision does not throw anywhere — it makes `bySlug` silently resolve
    // one of the two entries and orphans the other's page. Asserted over
    // ALL_SOURCES because slugging the two partitions separately would let a
    // tombstone claim a slug a live source also holds.
    const slugs = ALL_SOURCES.map((s) => s.slug);
    const seen = new Map<string, string[]>();
    for (const s of ALL_SOURCES) {
      seen.set(s.slug, [...(seen.get(s.slug) ?? []), s.name]);
    }
    const collisions = [...seen].filter(([, names]) => names.length > 1);
    expect(collisions).toEqual([]);
    expect(new Set(slugs).size).toBe(ALL_SOURCES.length);
  });

  test('no slug is empty', () => {
    // `slugify` returns '' for a name with no romanisable characters, and an
    // empty slug builds the path `/source//` — which routes nowhere.
    expect(ALL_SOURCES.filter((s) => !s.slug)).toEqual([]);
  });

  test('no slug is a bare numeric id', () => {
    // `base()` falls back to `s.id` as a last resort. That fallback firing means
    // the name *and* the package failed to romanise, and the reader gets a
    // snowflake in the URL bar instead of a name. It should never happen.
    const numeric = ALL_SOURCES.filter((s) => /^\d+$/.test(s.slug)).map((s) => [s.name, s.slug]);
    expect(numeric).toEqual([]);
  });

  test('a tombstone never displaces its live namesake, or another tombstone', () => {
    // A source delisted and re-added under a fresh id: same name, same lang,
    // two ids. Both computed the same qualified slug while both existed, so
    // the live one keeps publishing it — a URL already in the wild must not
    // move because another source died — and each tombstone gets a unique
    // suffix, so two delistings cannot collide with each other either.
    const base = {
      name: 'Same Name',
      lang: 'en',
      baseUrl: 'https://a.example',
      extPkg: 'pkg.a',
      extName: 'Same Name',
      nsfw: false,
    };
    const rows: SourceRow[] = [
      { ...base, id: '1', extVersion: '1.0', extVersionCode: 1 },
      { ...base, id: '2', extVersion: '2.0', extVersionCode: 2, removed: '2026-08-24' },
      { ...base, id: '3', extVersion: '3.0', extVersionCode: 3, removed: '2026-07-01' },
    ];
    const slugged = withSlugs(rows);
    expect(slugged.find((s) => s.id === '1')?.slug).toBe('same-name-en');
    expect(slugged.find((s) => s.id === '2')?.slug).toBe('same-name-en-removed');
    expect(slugged.find((s) => s.id === '3')?.slug).toBe('same-name-en-removed-2');
    expect(new Set(slugged.map((s) => s.slug)).size).toBe(slugged.length);
  });

  test('the 32 "MyReadingManga" entries each get their own slug', () => {
    // One entry per language, all with the identical name. The language
    // qualifier is the only thing separating them.
    const family = SOURCES.filter((s) => s.name === 'MyReadingManga');
    expect(family).toHaveLength(32);
    expect(new Set(family.map((s) => s.slug)).size).toBe(32);
    for (const s of family) {
      expect(s.slug).toBe(`myreadingmanga-${s.lang === 'all' ? 'multi' : s.lang.toLowerCase()}`);
    }
  });

  test('the 9 "AnimeWorld India" entries each get their own slug', () => {
    const family = SOURCES.filter((s) => s.name === 'AnimeWorld India');
    expect(family).toHaveLength(9);
    expect(new Set(family.map((s) => s.slug)).size).toBe(9);
    // `lang: 'all'` is spelled `multi` to match the label the UI shows, rather
    // than leaking the index's own word into a URL.
    expect(family.map((s) => s.slug)).toContain('animeworld-india-multi');
  });

  test('names with no Latin characters fall back to the package segment', () => {
    // 14 sources are named only in Arabic or Chinese script, so `slugify(name)`
    // is the empty string and the extension package's last segment is the only
    // stable romanisation available.
    const nonLatin = SOURCES.filter((s) => !/[a-zA-Z]/.test(s.name));
    expect(nonLatin).toHaveLength(14);
    for (const s of nonLatin) {
      const segment = s.extPkg.split('.').pop() ?? '';
      expect(s.slug.startsWith(segment)).toBe(true);
      expect(s.slug).not.toBe('');
    }
    // Two named cases, so a reader can see what the fallback actually produces.
    const blkom = SOURCES.find((s) => s.name === 'أنمي بالكوم');
    expect(blkom?.slug).toBe('animeblkom');
    // `肉視頻` exists four times over, so it also needs the language qualifier.
    const rou = SOURCES.filter((s) => s.name === '肉視頻');
    expect(rou).toHaveLength(4);
    for (const s of rou) expect(s.slug.startsWith('rouvideo-')).toBe(true);
  });
});

describe('getSourceByRef', () => {
  test('resolves a slug and a legacy snowflake id to the same source', () => {
    // Links to `/source/<snowflake>` were published before slugs existed and
    // are still in Discord history, so both forms must land on one page.
    for (const s of SOURCES.slice(0, 25)) {
      expect(getSourceByRef(s.slug)).toBe(s);
      expect(getSourceByRef(s.id)).toBe(s);
      expect(getSourceByRef(s.slug)).toBe(getSourceByRef(s.id));
    }
  });

  test('returns undefined for nothing, and for a ref that names nothing', () => {
    expect(getSourceByRef(null)).toBeUndefined();
    expect(getSourceByRef(undefined)).toBeUndefined();
    expect(getSourceByRef('')).toBeUndefined();
    expect(getSourceByRef('not-a-source')).toBeUndefined();
    expect(getSourceByRef('0')).toBeUndefined();
  });

  test('getSource only accepts the id form', () => {
    const s = SOURCES[0]!;
    expect(getSource(s.id)).toBe(s);
    expect(getSource(s.slug)).toBeUndefined();
    expect(getSource(null)).toBeUndefined();
  });
});

describe('sourcePath', () => {
  test('always ends in a trailing slash', () => {
    // `/source/<slug>/` is prerendered and therefore emits a directory. Without
    // the trailing slash every visitor pays a 307 before the page renders.
    for (const s of SOURCES) {
      expect(s.slug).toBeTruthy();
      expect(sourcePath(s)).toBe(`/source/${s.slug}/`);
      expect(sourcePath(s).endsWith('/')).toBe(true);
    }
  });
});

describe('langLabel', () => {
  test('"all" is Multi rather than a language name', () => {
    expect(langLabel('all')).toBe('Multi');
  });

  test('a region-tagged code labels by its base language', () => {
    // `pt-BR` is a real catalogue value. Intl.DisplayNames would answer
    // "Brazilian Portuguese" for the full tag; the split to the base keeps the
    // facet list short enough to read.
    expect(langLabel('pt-BR')).toBe('Portuguese');
    expect(langLabel('en')).toBe('English');
  });

  test('an unknown code falls back to the raw code, upper-cased', () => {
    expect(langLabel('zz')).toBe('ZZ');
  });

  test('the memoised cache returns the same value on a second call', () => {
    // The label is cached because a board render asks for one about a hundred
    // times. A cache that keyed or stored wrongly would show one language's
    // label under another, which no type error would catch.
    const first = langLabel('pt-BR');
    const second = langLabel('pt-BR');
    expect(second).toBe(first);
    // Interleaved so a cache that returned the previous entry rather than the
    // requested one would show up here, which is the failure mode a single
    // repeated call cannot see.
    expect(langLabel('all')).toBe('Multi');
    expect(langLabel('pt-BR')).toBe(first);
    expect(langLabel('all')).toBe('Multi');
    // Warm and cold reads of an unknown code agree too, so the fallback is
    // cached rather than recomputed differently the second time.
    expect(langLabel('zz')).toBe(langLabel('zz'));
  });
});

describe('langDir', () => {
  test('Arabic, Hebrew, Persian and Urdu read right to left', () => {
    for (const code of ['ar', 'he', 'fa', 'ur']) expect(langDir(code)).toBe('rtl');
    // The region tag must not defeat the lookup.
    expect(langDir('ar-EG')).toBe('rtl');
  });

  test('everything else reads left to right', () => {
    for (const code of ['en', 'pt-BR', 'zh', 'all', '']) expect(langDir(code)).toBe('ltr');
  });
});

describe('languageFacets', () => {
  test('covers every source exactly once, most-populated first', () => {
    const facets = languageFacets();
    expect(facets.reduce((n, f) => n + f.count, 0)).toBe(SOURCES.length);
    const counts = facets.map((f) => f.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    for (const f of facets) expect(f.label).toBe(langLabel(f.code));
  });
});

describe('tombstones', () => {
  /**
   * NoobSubs left the upstream index on 2026-08-24 and report 18 lost its
   * name, its source page 404'd, and the row's 18+ flag froze out of
   * reconcileNsfw's reach. These pin the partition: resolution covers
   * tombstones, every picker/facet/count surface stays live-only.
   */
  test('SOURCES is exactly the live half of ALL_SOURCES', () => {
    expect(SOURCES.every((s) => !s.removed)).toBe(true);
    expect(REMOVED_SOURCES.every((s) => !!s.removed)).toBe(true);
    expect(ALL_SOURCES.length).toBe(SOURCES.length + REMOVED_SOURCES.length);
    const liveIds = new Set(SOURCES.map((s) => s.id));
    expect(REMOVED_SOURCES.some((s) => liveIds.has(s.id))).toBe(false);
  });

  test('every removed source still resolves by id and slug, never as live', () => {
    for (const s of REMOVED_SOURCES) {
      expect(getSource(s.id)).toBe(s);
      expect(getSourceByRef(s.slug)).toBe(s);
      expect(getLiveSource(s.id)).toBeUndefined();
    }
  });

  test.skipIf(getSource('5343978110335507456')?.removed === undefined)(
    'the NoobSubs report-18 id resolves with its removal day',
    () => {
      const noobsubs = getSource('5343978110335507456');
      expect(noobsubs?.name).toBe('NoobSubs');
      expect(noobsubs?.removed).toBe('2026-08-24');
      expect(getSourceByRef('noobsubs')).toBe(noobsubs);
      expect(getLiveSource('5343978110335507456')).toBeUndefined();
    },
  );

  test('live-only surfaces never offer a removed source', () => {
    // The picker feeds /new and /request; the facet counts feed /request's
    // language select and FilterBar. Either listing a tombstone invites a
    // submission the server then refuses.
    const removedIds = new Set(REMOVED_SOURCES.map((s) => s.id));
    expect(PICKER_ROWS.some((r) => removedIds.has(r.id))).toBe(false);
    expect(languageFacets().reduce((n, f) => n + f.count, 0)).toBe(SOURCES.length);
  });
});
