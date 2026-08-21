import { describe, expect, test } from 'bun:test';
import {
  PROBLEMS,
  PROBLEM_KEYS,
  normaliseUrl,
  problemByKey,
  problemNeedsDetail,
  problemNeedsUrl,
} from '../../src/lib/problems';

describe('PROBLEM_KEYS', () => {
  test('matches the seven PROBLEMS entries, in order', () => {
    // The keys drive the `problem` column's enum and the third column of the
    // unique index. Deriving them rather than writing them out again is what
    // stops the column and the form disagreeing about what a problem is, so
    // this asserts the derivation actually holds.
    expect(PROBLEMS).toHaveLength(7);
    expect(PROBLEM_KEYS).toHaveLength(7);
    expect([...PROBLEM_KEYS]).toEqual(PROBLEMS.map((p) => p.key));
  });

  test('the keys are unique', () => {
    // A duplicate key would make `problemByKey` resolve one entry for two
    // buttons, so two distinct failures would dedupe onto each other.
    expect(new Set(PROBLEM_KEYS).size).toBe(PROBLEM_KEYS.length);
  });

  test('every entry carries the columns the report row needs', () => {
    for (const p of PROBLEMS) {
      expect(p.key).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.hint).toBeTruthy();
      expect(['bug', 'domain', 'dead']).toContain(p.kind);
      expect([null, 'browse', 'episodes', 'video']).toContain(p.stage);
      expect(p.cause).toBeTruthy();
    }
  });

  test('exactly one problem asks for a URL and exactly one for a description', () => {
    // Both extra fields are full-width and live last in the grid; a third would
    // silently break that layout, and a second `needsUrl` would mean two
    // buttons competing for the same `new_url`.
    expect(PROBLEMS.filter(problemNeedsUrl).map((p) => p.key)).toEqual(['moved']);
    expect(PROBLEMS.filter(problemNeedsDetail).map((p) => p.key)).toEqual(['other']);
  });

  test('problemByKey resolves every key and nothing else', () => {
    for (const key of PROBLEM_KEYS) expect(problemByKey(key)?.key).toBe(key);
    expect(problemByKey('')).toBeUndefined();
    expect(problemByKey('no-such-problem')).toBeUndefined();
  });
});

describe('normaliseUrl', () => {
  test('accepts a bare host by assuming https', () => {
    // People paste hosts, not URLs. Bouncing the form here is the difference
    // between a usable report and no report.
    expect(normaliseUrl('animefire.plus')).toBe('https://animefire.plus');
    expect(normaliseUrl('www.animefire.plus')).toBe('https://www.animefire.plus');
  });

  test('keeps an explicit scheme, including plain http', () => {
    expect(normaliseUrl('http://animefire.plus')).toBe('http://animefire.plus');
    expect(normaliseUrl('HTTPS://AnimeFire.plus')).toBe('https://animefire.plus');
  });

  test('trims whitespace and trailing punctuation', () => {
    // Addresses arrive at the end of a sentence, or pasted out of a list.
    expect(normaliseUrl('  animefire.plus  ')).toBe('https://animefire.plus');
    expect(normaliseUrl('animefire.plus,')).toBe('https://animefire.plus');
    expect(normaliseUrl('animefire.plus;')).toBe('https://animefire.plus');
    expect(normaliseUrl('animefire.plus ,; ')).toBe('https://animefire.plus');
  });

  test('keeps a path but drops a trailing slash', () => {
    expect(normaliseUrl('https://animefire.plus/browse/')).toBe('https://animefire.plus/browse');
    expect(normaliseUrl('https://animefire.plus/')).toBe('https://animefire.plus');
  });

  test('a hostname with no dot is a typo, not a domain', () => {
    expect(normaliseUrl('localhost')).toBeNull();
    expect(normaliseUrl('animefire')).toBeNull();
    expect(normaliseUrl('http://localhost:8787')).toBeNull();
  });

  test('a non-HTTP scheme is refused', () => {
    // This is what keeps a hostile scheme out of the `new_url` href on the
    // report page: a stored `javascript:` address rendered into an anchor is a
    // stored XSS, and a domain-change report exists to publish a link.
    //
    // Two rules combine to refuse these, and both matter. Anything without an
    // http(s) prefix has `https://` prepended, which turns `javascript:alert(1)`
    // into a URL with an invalid port that fails to parse; the explicit
    // protocol check then covers whatever the parser would otherwise accept.
    // Asserted case by case rather than in a loop, because each of these is a
    // separate thing an attacker would try.
    expect(normaliseUrl('javascript:alert(1)')).toBeNull();
    expect(normaliseUrl('JavaScript:alert(1)')).toBeNull();
    expect(normaliseUrl('javascript://evil.example/%0aalert(1)')).toBeNull();
    expect(normaliseUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(normaliseUrl('vbscript:msgbox(1)')).toBeNull();
    expect(normaliseUrl('file:///etc/passwd')).toBeNull();
    // A scheme name with no colon is only a hostname, and it has no dot.
    expect(normaliseUrl('javascript')).toBeNull();
  });

  test('empty and unparseable input returns null', () => {
    expect(normaliseUrl('')).toBeNull();
    expect(normaliseUrl('   ')).toBeNull();
    expect(normaliseUrl(',,,')).toBeNull();
    expect(normaliseUrl('http://')).toBeNull();
    expect(normaliseUrl('https://[')).toBeNull();
  });
});
