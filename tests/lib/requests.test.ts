import { describe, expect, test } from 'bun:test';
import { duplicateOf, normName, suggestRequests } from '../../src/lib/requests';

/**
 * These are the rule the request form and the server both act on, so the two
 * cannot be allowed to drift: the type-ahead promises "you'll be added to this
 * one" and the POST handler has to make good on it.
 *
 * No `cloudflare:workers` stub here, unlike tests/lib/writes.test.ts — the
 * reason lib/requests.ts imports lib/host.ts rather than lib/writes.ts is that
 * a browser has to be able to import it too.
 */

const OPEN = [
  { id: 1, name: 'AnimeFire', url: 'https://animefire.plus', votes: 12 },
  { id: 2, name: 'HiAnime', url: 'https://hianime.to', votes: 40 },
  { id: 3, name: 'Anime Unity', url: 'https://www.animeunity.so/watch', votes: 3 },
  { id: 4, name: 'Old import', url: null, votes: 1 },
];

describe('normName', () => {
  test('case, spacing and punctuation are not part of a site name', () => {
    expect(normName('Anime Fire')).toBe(normName('animefire'));
    expect(normName('AnimeFire!')).toBe(normName('anime-fire'));
  });
});

describe('duplicateOf', () => {
  test('the same host is the same request, however it was typed', () => {
    expect(duplicateOf(OPEN, 'Something else', 'animefire.plus')?.id).toBe(1);
    expect(duplicateOf(OPEN, 'Something else', 'https://www.AnimeFire.plus/browse')?.id).toBe(1);
    // Stored with www. and a path, asked for bare.
    expect(duplicateOf(OPEN, '', 'animeunity.so')?.id).toBe(3);
  });

  test('the same name is the same request, however the address differs', () => {
    // People reach one site by several domains, which is half of why requests
    // are deduplicated on the name as well.
    expect(duplicateOf(OPEN, 'anime fire', 'https://animefire.com')?.id).toBe(1);
  });

  test('a different site is a different request', () => {
    expect(duplicateOf(OPEN, 'Aniwatch', 'aniwatch.to')).toBeUndefined();
  });

  test('a suffix of a stored host is not a match', () => {
    // The whole point of comparing hosts for equality: `hianime.to` must not
    // swallow a request for `anime.to`.
    expect(duplicateOf(OPEN, 'Anime TO', 'anime.to')).toBeUndefined();
  });

  test('an empty form matches nothing', () => {
    // Otherwise the first row of the table is a "duplicate" of a blank form,
    // and the panel offers to merge into it before anything has been typed.
    expect(duplicateOf(OPEN, '', '')).toBeUndefined();
    expect(duplicateOf(OPEN, '   ', '   ')).toBeUndefined();
  });

  test('a stored row with no address is still matched by name', () => {
    expect(duplicateOf(OPEN, 'old import', '')?.id).toBe(4);
  });
});

describe('suggestRequests', () => {
  test('a partial name finds the request', () => {
    expect(suggestRequests(OPEN, 'anime', '').map((r) => r.id)).toContain(1);
  });

  test('prefix matches come before substring matches', () => {
    // "anime" prefixes AnimeFire and Anime Unity, and is inside HiAnime.
    const ids = suggestRequests(OPEN, 'anime', '').map((r) => r.id);
    expect(ids.indexOf(2)).toBeGreaterThan(ids.indexOf(1));
  });

  test('a name query is tried against stored addresses too', () => {
    // Typing the domain into the name field still finds the request, which is
    // what people do when they only know the site by its URL.
    expect(suggestRequests(OPEN, 'hianime.to', '').map((r) => r.id)).toContain(2);
  });

  test('a typed address suggests on its own', () => {
    expect(suggestRequests(OPEN, '', 'animefire.plus').map((r) => r.id)).toEqual([1]);
  });

  test('one character suggests nothing', () => {
    // Below two characters every request matches and the panel is noise.
    expect(suggestRequests(OPEN, 'a', '')).toEqual([]);
    expect(suggestRequests(OPEN, '', '')).toEqual([]);
  });

  test('the limit is honoured', () => {
    expect(suggestRequests(OPEN, 'anime', '', 2)).toHaveLength(2);
  });
});
