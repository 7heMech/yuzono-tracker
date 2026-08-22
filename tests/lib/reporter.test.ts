import { describe, expect, test } from 'bun:test';
import { isRealAccount, reporterMeta, reporterName } from '../../src/lib/reporter';

/**
 * The Discord announcement used to print a raw snowflake where the reporter's
 * name belonged, because it sent `<@id>` into an embed that pings nobody and
 * therefore carries nothing for a client to resolve. What it sends now is the
 * stored username, which means this module has to answer for a real account and
 * for the two synthetic ones without ever reading the database for the latter.
 */

const USERS: Record<string, { username: string }> = { '297145': { username: 'mech' } };

/** Stands in for dbUser, and records that it was not called for a fake id. */
function loader() {
  const asked: string[] = [];
  return {
    asked,
    load: async (id: string) => {
      asked.push(id);
      return USERS[id];
    },
  };
}

describe('isRealAccount', () => {
  test('the two synthetic reporters are not accounts', () => {
    expect(isRealAccount('0')).toBe(false);
    expect(isRealAccount('github')).toBe(false);
  });

  test('a snowflake is', () => {
    expect(isRealAccount('297145')).toBe(true);
  });

  test('an inherited property name is not a synthetic reporter', () => {
    // `id in SYNTHETIC` would answer true for these, which would have shown
    // "imported from GitHub" for an account whose id was `constructor`.
    expect(isRealAccount('constructor')).toBe(true);
    expect(isRealAccount('toString')).toBe(true);
  });
});

describe('reporterName', () => {
  test('a real account reads the username', async () => {
    const { asked, load } = loader();
    expect(await reporterName('297145', load)).toBe('mech');
    expect(asked).toEqual(['297145']);
  });

  test('the synthetic reporters cost no lookup', async () => {
    const { asked, load } = loader();
    expect(await reporterName('0', load)).toBe('imported from GitHub');
    expect(await reporterName('github', load)).toBe('opened on GitHub');
    expect(asked).toEqual([]);
  });

  test('a missing user row does not leak the id', async () => {
    // The old code sent `<@id>`, so a deleted user showed as digits. Anything
    // is better than a number nobody can read.
    const { load } = loader();
    expect(await reporterName('999999', load)).toBe('unknown');
  });
});

describe('reporterMeta', () => {
  test('the page and the announcement get the same string', () => {
    expect(reporterMeta('297145', { username: 'mech' }).display).toBe('mech');
    expect(reporterMeta('0').display).toBe('imported from GitHub');
  });
});
