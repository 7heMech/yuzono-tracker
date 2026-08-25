import { describe, expect, test } from 'bun:test';
import { flatten, mergeCatalogue } from '../../scripts/sync-sources';
import type { SourceRow } from '../../src/lib/sources';

/**
 * Report 18 read "on an unknown source" for days after NoobSubs left the
 * upstream index, because the sync rewrote sources.json wholesale: reports
 * hold a bare source_id, so a dropped row took every report's name, page and
 * 18+ governance with it. mergeCatalogue is what keeps tombstones alive now —
 * and what must keep the five-minute commit diff empty once nothing moves.
 */

const row = (id: string, name: string, lang = 'en', over: Partial<SourceRow> = {}): SourceRow => ({
  id,
  name,
  lang,
  baseUrl: `https://${name.toLowerCase().replace(/\W+/g, '')}.example`,
  extPkg: `ext.pkg.${id}`,
  extName: name,
  extVersion: '1.0',
  extVersionCode: 1,
  nsfw: false,
  ...over,
});

describe('flatten', () => {
  test('skips a duplicate id but keeps the first row', () => {
    const { rows, duplicates } = flatten([
      {
        name: 'Aniyomi: Alpha',
        pkg: 'pkg.alpha',
        apk: 'a.apk',
        lang: 'en',
        code: 1,
        version: '1.0',
        nsfw: 0,
        sources: [
          { name: 'Alpha', lang: 'en', id: '1', baseUrl: 'https://alpha.example' },
          { name: 'Alpha again', lang: 'en', id: '1', baseUrl: 'https://alpha.example' },
          { name: 'Beta', lang: 'en', id: '2', baseUrl: 'https://beta.example' },
        ],
      },
    ]);
    expect(duplicates).toBe(1);
    expect(rows.map((r) => r.id)).toEqual(['1', '2']);
    // The display prefix is stripped into extName; the source row is untouched.
    expect(rows[0]).toMatchObject({ extName: 'Alpha', extPkg: 'pkg.alpha' });
  });
});

describe('mergeCatalogue', () => {
  test('an id upstream dropped carries over verbatim with removed set to today', () => {
    const previous = [row('1', 'Alpha'), row('2', 'Beta')];
    const upstream = [row('1', 'Alpha')];

    const merged = mergeCatalogue(previous, upstream, '2026-08-24');

    expect(merged).toEqual([row('1', 'Alpha'), { ...row('2', 'Beta'), removed: '2026-08-24' }]);
  });

  test('merging twice changes nothing, even across days', () => {
    // Idempotence is what keeps the 5-minute commit diff empty. A restamp on a
    // later run would churn the file forever, so the second pass runs with a
    // different "today".
    const previous = [row('1', 'Alpha', 'en', { removed: '2026-01-01' }), row('2', 'Beta')];
    const upstream = [row('2', 'Beta')];

    const once = mergeCatalogue(previous, upstream, '2026-08-24');
    const twice = mergeCatalogue(once, upstream, '2026-08-25');

    expect(twice).toEqual(once);
    expect(twice.find((r) => r.id === '1')?.removed).toBe('2026-01-01');
  });

  test('a returning id comes back live with upstream fields, not stale ones', () => {
    const previous = [
      { ...row('1', 'Old Name', 'en', { extVersion: '0.9' }), removed: '2026-01-01' },
    ];
    const upstream = [row('1', 'New Name', 'en', { extVersion: '9.9' })];

    const merged = mergeCatalogue(previous, upstream, '2026-08-24');

    expect(merged).toEqual([row('1', 'New Name', 'en', { extVersion: '9.9' })]);
    expect(merged[0]?.removed).toBeUndefined();
  });

  test('output sorts by name then lang, tombstones interleaved', () => {
    // Sorted as one list, not two partitions: the catalogue is one alphabetical
    // file, and a tombstone appended at the end would diff as a moved block on
    // every sync.
    const previous = [
      row('gone-es', 'Zeta', 'es'),
      row('gone-en', 'Midway'),
      row('stay', 'Alpha'),
    ];
    const upstream = [row('stay', 'Alpha'), row('new', 'Zeta', 'en')];

    const merged = mergeCatalogue(previous, upstream, '2026-08-24');

    expect(merged.map((r) => [r.id, r.removed ?? null])).toEqual([
      ['stay', null],
      ['gone-en', '2026-08-24'],
      ['new', null],
      ['gone-es', '2026-08-24'],
    ]);
  });
});
