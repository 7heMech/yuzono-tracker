import { and, eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { reports, votes } from './db/schema';

/**
 * Toggles a vote and moves the denormalised counter in the same D1 batch, so
 * the ranking column can never drift from the vote rows.
 */
export async function toggleVote(reportId: number, discordId: string) {
  const d = db();
  const existing = await d
    .select({ reportId: votes.reportId })
    .from(votes)
    .where(and(eq(votes.reportId, reportId), eq(votes.discordId, discordId)));

  if (existing.length) {
    await d.batch([
      d.delete(votes).where(and(eq(votes.reportId, reportId), eq(votes.discordId, discordId))),
      d
        .update(reports)
        .set({ votes: sql`max(0, ${reports.votes} - 1)` })
        .where(eq(reports.id, reportId)),
    ]);
    return 'removed' as const;
  }

  await d.batch([
    d.insert(votes).values({ reportId, discordId }).onConflictDoNothing(),
    d
      .update(reports)
      .set({ votes: sql`${reports.votes} + 1` })
      .where(eq(reports.id, reportId)),
  ]);
  return 'added' as const;
}

/** Adds a vote without toggling — used when resuming an intent after sign-in. */
export async function ensureVote(reportId: number, discordId: string) {
  const d = db();
  const existing = await d
    .select({ reportId: votes.reportId })
    .from(votes)
    .where(and(eq(votes.reportId, reportId), eq(votes.discordId, discordId)));
  if (existing.length) return;
  await d.batch([
    d.insert(votes).values({ reportId, discordId }).onConflictDoNothing(),
    d
      .update(reports)
      .set({ votes: sql`${reports.votes} + 1` })
      .where(eq(reports.id, reportId)),
  ]);
}
