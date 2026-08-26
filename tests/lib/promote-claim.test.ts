import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { describe, expect, mock, test } from 'bun:test';
import * as schema from '../../src/lib/db/schema';
import { schemaDb } from '../helpers/schema-db';

/**
 * The promotion claim, driven through the real `claimPromotion()`.
 *
 * Report 474 sat unsendable for a day because the old claim never expired: one
 * click fired the UPDATE, GitHub's form went unfilled, and every later click
 * answered "already been sent" to a report with no issue anywhere. These tests
 * pin the contract that came out of that: the claim refuses a double-tap,
 * releases after the window when no issue was filed, and never releases once
 * an issue is actually linked.
 */

const sqlite = await schemaDb();
const d = drizzle(sqlite, { schema });

mock.module('../../src/lib/db/client', () => ({
  db: () => d,
  schema,
}));

const { claimPromotion, PROMOTE_CLAIM_SECONDS } = await import('../../src/lib/writes');

await d.insert(schema.users).values({ discordId: 'test', username: 'Test', accountCreatedAt: 0 });

let seeded = 0;
const seedReport = async (over: Partial<typeof schema.reports.$inferInsert> = {}) => {
  seeded++;
  const [row] = await d
    .insert(schema.reports)
    .values({ kind: 'bug', lang: 'en', title: `Seed ${seeded}`, reporterId: 'test', ...over })
    .returning({ id: schema.reports.id });
  return row;
};

const promotedAtOf = async (id: number) => {
  const [row] = await d
    .select({ at: schema.reports.promotedAt, issue: schema.reports.githubIssue })
    .from(schema.reports)
    .where(eq(schema.reports.id, id));
  return row;
};

describe('claimPromotion', () => {
  test('an unclaimed report claims, and an immediate second click does not', async () => {
    const r = await seedReport();

    const first = await claimPromotion(r.id);
    expect(first?.id).toBe(r.id);
    const stored = await promotedAtOf(r.id);
    expect(stored.at).not.toBeNull();
    expect(stored.issue).toBeNull();

    expect(await claimPromotion(r.id)).toBeNull();
  });

  test('a claim past its window releases when no issue ever came back', async () => {
    const stale = Date.now() / 1000 - PROMOTE_CLAIM_SECONDS - 60;
    const r = await seedReport({ promotedAt: Math.floor(stale) });

    // The shape report 474 was stuck in: claimed yesterday, no issue anywhere.
    const again = await claimPromotion(r.id);
    expect(again?.id).toBe(r.id);

    const stored = await promotedAtOf(r.id);
    expect(stored.at!).toBeGreaterThan(stale);
  });

  test('a claim inside its window still holds', async () => {
    const fresh = Date.now() / 1000 - 60;
    const r = await seedReport({ promotedAt: Math.floor(fresh) });

    expect(await claimPromotion(r.id)).toBeNull();
    expect((await promotedAtOf(r.id)).at).toBe(Math.floor(fresh));
  });

  test('a linked issue blocks forever, however old the claim is', async () => {
    const stale = Date.now() / 1000 - PROMOTE_CLAIM_SECONDS - 60;
    const r = await seedReport({
      promotedAt: Math.floor(stale),
      githubIssue: 5123,
    });

    expect(await claimPromotion(r.id)).toBeNull();
    expect((await promotedAtOf(r.id)).issue).toBe(5123);
  });
});
