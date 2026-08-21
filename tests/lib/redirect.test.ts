import { describe, expect, test } from 'bun:test';
import { safeReturnTo } from '../../src/lib/redirect';

/**
 * `?next=` and the `Referer` header are both attacker-supplied and were both
 * being handed to `redirect()` unchecked, so a link like
 * `/auth/discord?next=https://evil.example` bounced someone to another site
 * *after* a successful Discord sign-in — the exact moment a phishing page wants
 * them. Every case the module's own comment names is asserted below.
 */
const ORIGIN = 'https://tracker.example';

describe('safeReturnTo', () => {
  test('a protocol-relative URL is refused', () => {
    // `//evil.example` looks like a path and is not one: resolved against any
    // origin it becomes an absolute URL somewhere else. This is the case a
    // naive `raw.startsWith('/')` check lets straight through.
    expect(safeReturnTo('//evil.example', ORIGIN)).toBe('/');
    expect(safeReturnTo('//evil.example/board', ORIGIN)).toBe('/');
    // Backslashes are normalised to slashes for http(s), so this is the same
    // attack wearing a disguise, and it is refused for the same reason.
    expect(safeReturnTo('/\\evil.example', ORIGIN)).toBe('/');
    expect(safeReturnTo('\\\\evil.example', ORIGIN)).toBe('/');
  });

  test('an absolute URL on another origin is refused', () => {
    expect(safeReturnTo('https://evil.example', ORIGIN)).toBe('/');
    expect(safeReturnTo('https://evil.example/board?x=1', ORIGIN)).toBe('/');
    // A different scheme or port on our own hostname is still another origin.
    expect(safeReturnTo('http://tracker.example/board', ORIGIN)).toBe('/');
    expect(safeReturnTo('https://tracker.example:8443/board', ORIGIN)).toBe('/');
    // And our hostname as a prefix of somebody else's is not us.
    expect(safeReturnTo('https://tracker.example.evil.test/board', ORIGIN)).toBe('/');
  });

  test('a javascript: URL is refused', () => {
    // It never parses to a matching origin, so it can never be returned.
    expect(safeReturnTo('javascript:alert(1)', ORIGIN)).toBe('/');
    expect(safeReturnTo('JavaScript:alert(document.cookie)', ORIGIN)).toBe('/');
    expect(safeReturnTo('data:text/html,<script>alert(1)</script>', ORIGIN)).toBe('/');
  });

  test('a legitimate same-origin path keeps its query string', () => {
    // The reason this function returns a string rather than a boolean: the
    // filters someone had applied before signing in have to survive the detour.
    expect(safeReturnTo('/board?kind=bug&page=2', ORIGIN)).toBe('/board?kind=bug&page=2');
    expect(safeReturnTo('/sources/', ORIGIN)).toBe('/sources/');
    expect(safeReturnTo('/source/animefire/', ORIGIN)).toBe('/source/animefire/');
    // An absolute URL on our own origin is fine, reduced to path and query.
    expect(safeReturnTo('https://tracker.example/report/12?x=1', ORIGIN)).toBe('/report/12?x=1');
  });

  test('the fragment is dropped, because it never reaches the server anyway', () => {
    expect(safeReturnTo('/board?x=1#top', ORIGIN)).toBe('/board?x=1');
  });

  test('nothing supplied falls back', () => {
    expect(safeReturnTo(null, ORIGIN)).toBe('/');
    expect(safeReturnTo(undefined, ORIGIN)).toBe('/');
    expect(safeReturnTo('', ORIGIN)).toBe('/');
  });

  test('the caller may choose its own fallback', () => {
    // /vote sends people back to the board rather than the home page.
    expect(safeReturnTo('https://evil.example', ORIGIN, '/board')).toBe('/board');
    expect(safeReturnTo(null, ORIGIN, '/board')).toBe('/board');
    expect(safeReturnTo('/report/9', ORIGIN, '/board')).toBe('/report/9');
  });
});
