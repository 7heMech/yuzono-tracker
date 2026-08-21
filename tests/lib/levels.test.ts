import { describe, expect, test } from 'bun:test';
import { LEVEL_LABELS, type Level, atLeast, combine } from '../../src/lib/levels';

/**
 * Authorisation arithmetic with no test is exactly the thing that quietly
 * inverts: swap the comparison and every gate opens for everyone, with no error
 * anywhere and nothing visibly different until someone notices a member holding
 * an admin control. So both functions are asserted across every pair rather
 * than at a few interesting points.
 */
const LEVELS = ['user', 'mod', 'admin', 'owner'] as const satisfies readonly Level[];

/** The intended order, written out independently of the module's RANK map. */
const ORDER: Record<Level, number> = { user: 0, mod: 1, admin: 2, owner: 3 };

describe('atLeast', () => {
  test('holds for every ordered pair', () => {
    for (const level of LEVELS) {
      for (const needed of LEVELS) {
        expect(atLeast(level, needed), `atLeast('${level}', '${needed}')`).toBe(
          ORDER[level] >= ORDER[needed],
        );
      }
    }
  });

  test('a level always satisfies itself', () => {
    // `>` instead of `>=` would lock an admin out of every admin-gated page.
    for (const level of LEVELS) expect(atLeast(level, level)).toBe(true);
  });

  test('the named cases that matter, spelled out', () => {
    // Written literally as well as in the loop above, so a reader can see the
    // direction of the comparison without reconstructing it.
    expect(atLeast('user', 'mod')).toBe(false);
    expect(atLeast('mod', 'admin')).toBe(false);
    expect(atLeast('admin', 'owner')).toBe(false);
    expect(atLeast('owner', 'admin')).toBe(true);
    expect(atLeast('admin', 'mod')).toBe(true);
    expect(atLeast('mod', 'user')).toBe(true);
  });
});

describe('combine', () => {
  test('takes the higher of the two grants, across every pair', () => {
    // There are two grants because one comes from Discord roles and one is set
    // by hand, and either alone must be enough. Taking the *lower* would mean
    // a hand-granted admin with no Discord role had no powers at all.
    const grants = [null, 'mod', 'admin'] as const;
    const expected = (a: (typeof grants)[number], b: (typeof grants)[number]) => {
      if (a === 'admin' || b === 'admin') return 'admin';
      if (a === 'mod' || b === 'mod') return 'mod';
      return 'user';
    };
    for (const discord of grants) {
      for (const manual of grants) {
        expect(combine(discord, manual), `combine(${discord}, ${manual})`).toBe(
          expected(discord, manual),
        );
      }
    }
  });

  test('no grant at all is a plain member, not staff', () => {
    // The default has to be the least privilege: this runs for every signed-in
    // account, and `null` is what an account with no roles carries.
    expect(combine(null, null)).toBe('user');
  });

  test('never returns owner', () => {
    // Ownership deliberately is not a tier — it comes from OWNER_DISCORD_ID in
    // the environment, so no dashboard action can grant it.
    const grants = [null, 'mod', 'admin'] as const;
    for (const discord of grants) {
      for (const manual of grants) expect(combine(discord, manual)).not.toBe('owner');
    }
  });

  test('the result is always a level atLeast understands', () => {
    // A combine that returned something outside RANK would make every
    // comparison against it `undefined >= n`, which is false — silently
    // denying everything rather than throwing.
    for (const discord of [null, 'mod', 'admin'] as const) {
      for (const manual of [null, 'mod', 'admin'] as const) {
        const level = combine(discord, manual);
        expect(LEVELS).toContain(level);
        expect(atLeast(level, 'user')).toBe(true);
      }
    }
  });
});

describe('LEVEL_LABELS', () => {
  test('every level has a non-empty label', () => {
    for (const level of LEVELS) expect(LEVEL_LABELS[level]).toBeTruthy();
    expect(Object.keys(LEVEL_LABELS).sort()).toEqual([...LEVELS].sort());
  });
});
