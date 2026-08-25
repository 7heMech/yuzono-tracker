import { describe, expect, mock, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../../src/lib/db/schema';
import { STATUSES } from '../../src/lib/db/schema';
import { BOARD_VIEW_COPY } from '../../src/lib/format';
import { schemaDb } from '../helpers/schema-db';

/**
 * The Other board view, driven through the real `board()` and `boardCounts()`.
 *
 * queries.ts reads D1 through lib/db/client, which imports `cloudflare:workers`
 * at module scope — the same wall every other database-touching module hits
 * under `bun test`. Stubbing that module and pointing `db()` at in-memory
 * SQLite replayed from the migrations means the query builders run exactly as
 * they ship, against the schema they run against in production.
 */

const sqlite = await schemaDb();
const d = drizzle(sqlite, { schema });

mock.module('../../src/lib/db/client', () => ({
  db: () => d,
  schema,
}));

const { board, boardCounts, parseBoardState } = await import('../../src/lib/queries');

const NOW = 1_700_000_000;
const daysAgo = (n: number) => NOW - n * 86_400;

await d.insert(schema.users).values({ discordId: 'test', username: 'Test', accountCreatedAt: 0 });

/* One report per status. Even-numbered seeds carry a closing date; odd ones
   do not, which is the shape of the real backlog's backfilled rows. */
for (const [i, status] of STATUSES.entries()) {
  await d.insert(schema.reports).values({
    kind: 'bug',
    lang: 'en',
    title: `Report ${i + 1}`,
    reporterId: 'test',
    sourceId: `source-${status}`,
    status,
    nsfw: false,
    createdAt: daysAgo((i + 1) * 10),
    updatedAt: daysAgo((i + 1) * 10),
    statusChangedAt: i % 2 === 1 ? daysAgo(i + 1) : null,
  });
}

describe('the three board states', () => {
  test('each state returns exactly its own statuses', async () => {
    const open = await board({ family: 'broken', state: 'open' });
    const fixed = await board({ family: 'broken', state: 'fixed' });
    const other = await board({ family: 'broken', state: 'other' });

    expect(open.rows.map((r) => r.status).sort()).toEqual(['confirmed', 'in_progress', 'open']);
    expect(fixed.rows.map((r) => r.status)).toEqual(['fixed']);
    // wont_fix and duplicate live only under other — before this view existed
    // they were addressable by no URL at all.
    expect(other.rows.map((r) => r.status).sort()).toEqual(['duplicate', 'wont_fix']);
  });

  test('the three chip counts sum to the seeded total', async () => {
    const counts = await boardCounts(false);
    expect(counts.broken).toBe(3);
    expect(counts.brokenFixed).toBe(1);
    expect(counts.brokenOther).toBe(2);
    expect(counts.broken + counts.brokenFixed + counts.brokenOther).toBe(6);
    expect(counts.wanted + counts.wantedFixed + counts.wantedOther).toBe(0);
  });

  test('the Other board sorts most recently closed first', async () => {
    const { rows } = await board({ family: 'broken', state: 'other' });
    const dates = rows.map((r) => r.statusChangedAt ?? r.updatedAt);
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  test('an unrecognised state param falls back to open rather than erroring', () => {
    expect(parseBoardState('other')).toBe('other');
    expect(parseBoardState('fixed')).toBe('fixed');
    expect(parseBoardState(null)).toBe('open');
    expect(parseBoardState('closed')).toBe('open');
    expect(parseBoardState('../etc')).toBe('open');
  });

  test('every view carries copy, and Other names its statuses outright', () => {
    for (const family of ['broken', 'wanted'] as const) {
      for (const [state, copy] of Object.entries(BOARD_VIEW_COPY[family])) {
        expect(copy.heading.length, `${family}/${state} heading`).toBeGreaterThan(0);
        if (state === 'other') {
          // The vague chip earns its name here or nowhere: the heading has to
          // say which statuses the view actually holds.
          expect(copy.heading).toMatch(/Won't (fix|add)/);
          expect(copy.heading).toMatch(/[Dd]uplicates/);
        }
      }
    }
  });
});
