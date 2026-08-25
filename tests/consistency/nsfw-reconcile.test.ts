import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import { inIds } from '../../src/lib/db/sql';
import { reports, users } from '../../src/lib/db/schema';
import { ALL_SOURCES, REMOVED_SOURCES, SOURCES } from '../../src/lib/sources';
import { schemaDb } from '../helpers/schema-db';

/**
 * The json_each pattern from reconcileNsfw, driven against the real schema.
 *
 * github-sync.ts itself cannot be imported under `bun test` (its db client
 * needs cloudflare:workers), so these tests rebuild its two catalogue
 * statements from the same pieces — the real `reports` table object, the real
 * `inIds`, the real catalogue — and run them against migrations replayed into
 * in-memory SQLite. What is pinned here is the SQL behaviour the D1 500s came
 * from: one parameter per statement at catalogue scale, snowflake ids matching
 * as TEXT, and rows with no source_id left alone. The tombstone block pins why
 * those lists must be built over ALL_SOURCES: over SOURCES alone, a delisted
 * id sits in neither list and its flag freezes permanently.
 */

const sqlite = await schemaDb();
const d = drizzle(sqlite);

const adult = SOURCES.filter((s) => s.nsfw).map((s) => s.id);
const tame = SOURCES.filter((s) => !s.nsfw).map((s) => s.id);
const allAdult = ALL_SOURCES.filter((s) => s.nsfw).map((s) => s.id);
const allTame = ALL_SOURCES.filter((s) => !s.nsfw).map((s) => s.id);

const flip = async (ids: string[], to: boolean) =>
  d
    .update(reports)
    .set({ nsfw: to })
    .where(and(inIds(reports.sourceId, ids), eq(reports.nsfw, !to)))
    .returning({ id: reports.id });

let seeded = 0;
const seedReport = async (over: Partial<typeof reports.$inferInsert> = {}) => {
  seeded++;
  const [row] = await d
    .insert(reports)
    .values({
      kind: 'bug',
      lang: 'en',
      title: `Seed ${seeded}`,
      reporterId: 'test',
      ...over,
    })
    .returning({ id: reports.id, sourceId: reports.sourceId, nsfw: reports.nsfw });
  return row;
};

beforeAll(async () => {
  await d.insert(users).values({ discordId: 'test', username: 'Test', accountCreatedAt: 0 });
});

describe('the reconcile statements over the real schema', () => {
  test('an adult-source row flips off → on and a tame-source row on → off', async () => {
    const adultId = SOURCES.find((s) => s.nsfw)!.id;
    const tameId = SOURCES.find((s) => !s.nsfw)!.id;
    const wrongAdult = await seedReport({ sourceId: adultId });
    const wrongTame = await seedReport({ sourceId: tameId, nsfw: true });

    const [on, off] = await Promise.all([flip(adult, true), flip(tame, false)]);
    expect(on.map((r) => r.id)).toContain(wrongAdult.id);
    expect(off.map((r) => r.id)).toContain(wrongTame.id);

    const after = await d
      .select({ id: reports.id, nsfw: reports.nsfw })
      .from(reports)
      .where(inIds(reports.id, [wrongAdult.id, wrongTame.id]));
    expect(after.find((r) => r.id === wrongAdult.id)?.nsfw).toBe(true);
    expect(after.find((r) => r.id === wrongTame.id)?.nsfw).toBe(false);
  });

  test('a snowflake id past Number.MAX_SAFE_INTEGER matches as TEXT', async () => {
    // The affinity trap: pushed through Number, this id loses precision and
    // would match nothing — silently, which is worse than the 500 it replaced.
    const SNOWFLAKE = '9200000000000000042';
    expect(Number(SNOWFLAKE)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    const row = await seedReport({ sourceId: SNOWFLAKE });
    const moved = await flip([SNOWFLAKE], true);
    expect(moved.map((r) => r.id)).toEqual([row.id]);
  });

  test('the full 309-id catalogue runs as two single-parameter statements', async () => {
    // One deliberately-wrong row per direction, then both full lists at once.
    // Before json_each this shape was a guaranteed D1 500 at 100 parameters,
    // chunked or not; here it is two statements, one parameter each.
    const wrongAdult = SOURCES.filter((s) => s.nsfw)[5];
    const wrongTame = SOURCES.find((s) => !s.nsfw)!;
    const a = await seedReport({ sourceId: wrongAdult.id });
    const t = await seedReport({ sourceId: wrongTame.id, nsfw: true });

    const [on, off] = await Promise.all([flip(adult, true), flip(tame, false)]);
    expect(on.map((r) => r.id)).toContain(a.id);
    expect(off.map((r) => r.id)).toContain(t.id);
  });

  test('rows with no source_id are untouched by the catalogue statements', async () => {
    // The asymmetry reconcileNsfw protects: a moderator's hand-set flag on a
    // catalogue-less row survives, because nothing without a source_id can be
    // matched by either list.
    const unflagged = await seedReport({ sourceId: null });
    const flagged = await seedReport({ sourceId: null, nsfw: true });

    await Promise.all([flip(adult, true), flip(tame, false)]);

    const after = await d
      .select({ id: reports.id, nsfw: reports.nsfw })
      .from(reports)
      .where(inIds(reports.id, [unflagged.id, flagged.id]));
    expect(after.find((r) => r.id === unflagged.id)?.nsfw).toBe(false);
    expect(after.find((r) => r.id === flagged.id)?.nsfw).toBe(true);
  });
});

describe('tombstones', () => {
  /**
   * A delisted source's id is in neither SOURCES-derived list, so under the
   * old lists its rows never moved again — and the 18+ toggle on /report is
   * gated to catalogue-less rows, so nothing could fix it by hand. Building
   * the lists over ALL_SOURCES restores governance from the last known flag.
   */
  test.skipIf(!REMOVED_SOURCES.some((s) => s.nsfw))(
    'a tombstoned adult id reconciles only when the lists see tombstones',
    async () => {
      const dead = REMOVED_SOURCES.find((s) => s.nsfw)!;
      expect(allAdult).toContain(dead.id);
      expect(adult).not.toContain(dead.id);

      // Under the live-only lists: frozen at whatever the row says.
      const frozen = await seedReport({ sourceId: dead.id });
      await Promise.all([flip(adult, true), flip(tame, false)]);
      const mid = await d
        .select({ id: reports.id, nsfw: reports.nsfw })
        .from(reports)
        .where(eq(reports.id, frozen.id));
      expect(mid[0]?.nsfw).toBe(false);

      // Under the full catalogue: corrected, both ways like any live row.
      await Promise.all([flip(allAdult, true), flip(allTame, false)]);
      const after = await d
        .select({ id: reports.id, nsfw: reports.nsfw })
        .from(reports)
        .where(eq(reports.id, frozen.id));
      expect(after[0]?.nsfw).toBe(true);
    },
  );

  test.skipIf(REMOVED_SOURCES.every((s) => s.nsfw))(
    'a tombstoned tame id clears a wrongly-set flag through the full catalogue',
    async () => {
      const dead = REMOVED_SOURCES.find((s) => !s.nsfw)!;
      expect(allTame).toContain(dead.id);
      expect(tame).not.toContain(dead.id);

      // The live-only lists cannot reach it: wrongly marked 18+, it stays
      // marked no matter how many passes run.
      const wrong = await seedReport({ sourceId: dead.id, nsfw: true });
      await Promise.all([flip(adult, true), flip(tame, false)]);
      const mid = await d
        .select({ id: reports.id, nsfw: reports.nsfw })
        .from(reports)
        .where(eq(reports.id, wrong.id));
      expect(mid[0]?.nsfw).toBe(true);

      // The full catalogue clears it from the last known flag.
      await Promise.all([flip(allAdult, true), flip(allTame, false)]);
      const after = await d
        .select({ id: reports.id, nsfw: reports.nsfw })
        .from(reports)
        .where(eq(reports.id, wrong.id));
      expect(after[0]?.nsfw).toBe(false);
    },
  );

  test('an id in neither partition is untouched even by the full catalogue', async () => {
    // Not in the catalogue at all — an adopted row whose source was never
    // matched. Neither list may claim it; that is reconcileNsfw's asymmetry,
    // unchanged by tombstones.
    const unflagged = await seedReport({ sourceId: '9200000000000000042' });
    const flagged = await seedReport({ sourceId: '9200000000000000042', nsfw: true });

    await Promise.all([flip(allAdult, true), flip(allTame, false)]);

    const after = await d
      .select({ id: reports.id, nsfw: reports.nsfw })
      .from(reports)
      .where(inIds(reports.id, [unflagged.id, flagged.id]));
    expect(after.find((r) => r.id === unflagged.id)?.nsfw).toBe(false);
    expect(after.find((r) => r.id === flagged.id)?.nsfw).toBe(true);
  });
});
