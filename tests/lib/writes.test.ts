import { describe, expect, mock, test } from 'bun:test';

/**
 * `src/lib/writes.ts` imports `./db/client`, which imports `cloudflare:workers`
 * at module scope for the D1 binding. That specifier only exists inside the
 * Workers runtime, so a plain `import` of writes.ts throws
 * "Cannot find package 'cloudflare:workers'" under `bun test` before any test
 * body runs — even though hostOf, sameHost and isReportId never touch the
 * database.
 *
 * Stubbing the module here rather than restructuring writes.ts keeps the module
 * under test exactly as it ships. The stub is deliberately empty: if one of
 * these three functions ever grows a database read, `env.DB` will be undefined
 * and the test will fail loudly instead of quietly exercising a mock.
 */
mock.module('cloudflare:workers', () => ({ env: {} }));

const { FILING_LIMIT, hostOf, isReportId, sameHost } = await import('../../src/lib/writes');

describe('hostOf', () => {
  test('lowercases, strips www. and drops the path', () => {
    expect(hostOf('https://www.AnimeFire.plus/browse')).toBe('animefire.plus');
    expect(hostOf('HTTPS://ANIMEFIRE.PLUS')).toBe('animefire.plus');
    expect(hostOf('https://animefire.plus/')).toBe('animefire.plus');
  });

  test('accepts an address with no scheme', () => {
    // People paste bare hosts. Refusing them would bounce an honest request.
    expect(hostOf('animefire.plus')).toBe('animefire.plus');
    expect(hostOf('www.animefire.plus/a/b')).toBe('animefire.plus');
    expect(hostOf('  animefire.plus  ')).toBe('animefire.plus');
  });

  test('keeps a port, because a different port is a different host', () => {
    expect(hostOf('http://example.com:8080/x')).toBe('example.com:8080');
  });

  test('returns null for garbage', () => {
    expect(hostOf('')).toBeNull();
    expect(hostOf('   ')).toBeNull();
    expect(hostOf('http://')).toBeNull();
    expect(hostOf('https://')).toBeNull();
    expect(hostOf(' /// ')).toBeNull();
  });
});

describe('sameHost', () => {
  /**
   * The whole reason this function exists. The previous test was
   * `stored.includes(host)`, which matched far more than it should.
   */
  test('a suffix is not a match — the innocent half of the old bug', () => {
    // `'https://anime.com'.includes('e.com')` is true, so a request for e.com
    // used to be swallowed by an unrelated request for anime.com.
    expect(sameHost('https://anime.com', 'https://e.com')).toBe(false);
    expect(sameHost('https://e.com', 'https://anime.com')).toBe(false);
  });

  test('a host hidden in a path is not a match — the deliberate half', () => {
    // A stored address of `https://evil.example/animefire.plus/hianime.to`
    // contains the host of every site someone might later ask for, and under a
    // substring test would have absorbed each of those requests, and their
    // votes, into itself.
    const hostile = 'https://evil.example/animefire.plus/hianime.to';
    expect(sameHost(hostile, 'https://animefire.plus')).toBe(false);
    expect(sameHost(hostile, 'animefire.plus')).toBe(false);
    expect(sameHost(hostile, 'https://hianime.to')).toBe(false);
    expect(sameHost(hostile, 'hianime.to')).toBe(false);
    // It matches only itself.
    expect(sameHost(hostile, 'https://evil.example/anything')).toBe(true);
  });

  test('a subdomain is a different host', () => {
    // Only `www.` is stripped; `cdn.` and friends are genuinely elsewhere.
    expect(sameHost('https://cdn.animefire.plus', 'https://animefire.plus')).toBe(false);
  });

  test('matches across scheme, case, www. and path differences', () => {
    expect(sameHost('http://WWW.AnimeFire.plus/browse?x=1', 'animefire.plus')).toBe(true);
    expect(sameHost('animefire.plus', 'https://www.animefire.plus/')).toBe(true);
  });

  test('two unparseable addresses are not "the same host"', () => {
    // Both sides are null here, and `null === null`. Returning true would make
    // every piece of garbage a duplicate of every other piece of garbage.
    expect(sameHost('', '')).toBe(false);
    expect(sameHost('http://', 'http://')).toBe(false);
    expect(sameHost('animefire.plus', '')).toBe(false);
  });
});

describe('isReportId', () => {
  test('rejects the value a missing form field actually produces', () => {
    // `Number(null)` is 0 and `Number.isInteger(0)` is true, which is how an
    // absent field used to reach the database as a vote for report 0.
    expect(isReportId(Number(null))).toBe(false);
    expect(isReportId(0)).toBe(false);
  });

  test('rejects the other shapes a form can hand over', () => {
    expect(isReportId(Number(undefined))).toBe(false); // NaN
    expect(isReportId(Number(''))).toBe(false); // also 0
    expect(isReportId(Number('abc'))).toBe(false); // NaN
    expect(isReportId(-1)).toBe(false);
    expect(isReportId(1.5)).toBe(false);
    expect(isReportId(Infinity)).toBe(false);
    // Beyond Number.MAX_SAFE_INTEGER an id no longer round-trips, so it cannot
    // be trusted as a foreign key even though it is an integer.
    expect(isReportId(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
  });

  test('accepts a real row id', () => {
    expect(isReportId(1)).toBe(true);
    expect(isReportId(468)).toBe(true);
    expect(isReportId(Number('468'))).toBe(true);
    expect(isReportId(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe('filing limit constants', () => {
  test('the cooldown is stated as a positive number of reports', () => {
    // A limit of 0 would lock every account out of /request on its first
    // filing, and the check is `>=`, so the sign matters.
    expect(FILING_LIMIT).toBeGreaterThan(0);
  });
});
