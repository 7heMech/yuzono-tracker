import { describe, expect, test } from 'bun:test';
import { APPS, APP_OTHER, compareVersions, isOutdated } from '../../src/lib/version';

/**
 * This gate sits in front of every breakage report: a false positive tells a
 * reporter to update when they are already current, and the real bug never gets
 * filed. That failure is invisible in production — nobody reports being unable
 * to report — so it has to be caught here.
 */
describe('compareVersions', () => {
  test('orders by numeric part, not lexically', () => {
    // '14.10' sorts before '14.2' as a string. It is a later release.
    expect(compareVersions('14.2', '14.10')).toBeLessThan(0);
    expect(compareVersions('14.10', '14.2')).toBeGreaterThan(0);
    expect(compareVersions('9.0.0', '10.0.0')).toBeLessThan(0);
  });

  test('a missing trailing part is zero, so unequal part counts still compare', () => {
    // The catalogue writes '14.1.0' and reporters type '14.1'. They are the
    // same release and must not be treated as an upgrade in either direction.
    expect(compareVersions('14.1', '14.1.0')).toBe(0);
    expect(compareVersions('14.1.0', '14.1')).toBe(0);
    expect(compareVersions('1', '1.0.0.0')).toBe(0);
    expect(compareVersions('14.1', '14.1.1')).toBeLessThan(0);
    expect(compareVersions('14.1.1', '14.1')).toBeGreaterThan(0);
  });

  test('a leading v is ignored, in either case', () => {
    expect(compareVersions('v14.2', '14.2')).toBe(0);
    expect(compareVersions('V14.2', 'v14.2')).toBe(0);
    expect(compareVersions('v14.2', '14.10')).toBeLessThan(0);
  });

  test('surrounding whitespace is ignored', () => {
    expect(compareVersions('  14.2  ', '14.2')).toBe(0);
  });

  test('non-numeric parts count as zero rather than poisoning the result', () => {
    // Prerelease suffixes are split on '-' and '+' and parse to 0, so a
    // prerelease compares equal to the release it precedes. That is the
    // conservative direction: it will not accuse anyone of being behind.
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3+build9', '1.2.3')).toBe(0);
    expect(compareVersions('abc', 'def')).toBe(0);
    expect(compareVersions('1.x.3', '1.0.3')).toBe(0);
  });
});

describe('isOutdated', () => {
  test('true only when the reported version is genuinely behind', () => {
    expect(isOutdated('14.1.0', '14.2.0')).toBe(true);
    expect(isOutdated('v14.2', '14.10')).toBe(true);
    expect(isOutdated('9.9.9', '10.0.0')).toBe(true);
  });

  test('false when current or ahead', () => {
    expect(isOutdated('14.2.0', '14.2.0')).toBe(false);
    expect(isOutdated('14.1', '14.1.0')).toBe(false);
    expect(isOutdated('14.3', '14.2')).toBe(false);
  });

  test('an empty input never blocks a report', () => {
    // Deliberate: we refuse to hold a report hostage to our own inability to
    // read what someone typed, or to a catalogue row with no version at all.
    expect(isOutdated('', '14.2.0')).toBe(false);
    expect(isOutdated('   ', '14.2.0')).toBe(false);
    expect(isOutdated('14.1.0', '')).toBe(false);
    expect(isOutdated('', '')).toBe(false);
  });

  test('an unparseable input never blocks a report', () => {
    // Same rule. Without the digit check, 'unknown' would parse to [0] and be
    // declared behind every real version — the exact false positive that hides
    // a genuine bug behind an "update first" message.
    expect(isOutdated('unknown', '14.2.0')).toBe(false);
    expect(isOutdated('latest', '14.2.0')).toBe(false);
    expect(isOutdated('???', '14.2.0')).toBe(false);
    // A version with any digit in it is read, even if the rest is junk.
    expect(isOutdated('v14 (beta)', '15.0.0')).toBe(true);
  });
});

describe('APPS', () => {
  test('"Other" is present and is the documented escape hatch', () => {
    // The form asks for a name when this is picked, so the constant and the
    // tuple entry must stay the same string.
    expect(APPS).toContain(APP_OTHER);
    expect(APP_OTHER).toBe('Other');
    expect(new Set(APPS).size).toBe(APPS.length);
  });
});
