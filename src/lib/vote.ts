import { and, eq, exists, notExists, sql } from 'drizzle-orm';
import { db } from './db/client';
import { reports, votes } from './db/schema';

/**
 * Voting, and the denormalised counter the whole board sorts on.
 *
 * The counter is moved by a delta rather than recomputed, and that is not
 * laziness: most rows carry demand that predates the `votes` table (imported
 * from the issue tracker, no vote rows behind it), so
 * `SET votes = (SELECT count(*) FROM votes ...)` would look like a repair and
 * would in fact wipe the ranking of every historical report. The delta is
 * therefore the load-bearing part, and it used to be written as
 *
 *     SELECT the vote row -> if none: INSERT ON CONFLICT DO NOTHING; UPDATE +1
 *
 * which decides the write from a read taken outside the write's transaction.
 * Two parallel POSTs from one cookie both saw "no row", both ran the insert
 * (the second a no-op) and both ran the increment — and because the decrement
 * floors at `max(0, votes - 1)` the drift only ever went upward, on exactly
 * the number that decides what the board shows first.
 *
 * So the guard now lives in the WHERE clause of the statement that moves the
 * counter, batched with the row that justifies it. A D1 batch is one implicit
 * transaction, so the second caller's UPDATE sees the first caller's committed
 * vote row and matches nothing: the counter cannot move without a vote row
 * appearing, and cannot move twice for one row.
 *
 * The guarded UPDATE must come *first* in each batch. Once the INSERT has run
 * the vote row exists either way, so a guard evaluated after it can no longer
 * tell "I just created this" from "it was already here" — putting the insert
 * first would mean the counter never moves at all.
 */

type Client = ReturnType<typeof db>;

const voteRow = (d: Client, reportId: number, discordId: string) =>
  d
    .select({ one: sql`1` })
    .from(votes)
    .where(and(eq(votes.reportId, reportId), eq(votes.discordId, discordId)));

/** Records a vote unless this person already has one. Returns whether it did. */
export async function addVote(reportId: number, discordId: string): Promise<boolean> {
  const d = db();
  const [, inserted] = await d.batch([
    d
      .update(reports)
      .set({ votes: sql`${reports.votes} + 1` })
      .where(and(eq(reports.id, reportId), notExists(voteRow(d, reportId, discordId)))),
    // RETURNING is the honest answer to "did this insert happen": a row comes
    // back only when one was written, and `ON CONFLICT DO NOTHING` returns
    // nothing. The UPDATE above tested the same condition in the same
    // transaction, so the two can only agree.
    d
      .insert(votes)
      .values({ reportId, discordId })
      .onConflictDoNothing()
      .returning({ reportId: votes.reportId }),
  ]);
  return inserted.length > 0;
}

/** Withdraws this person's vote if they have one. Returns whether it did. */
export async function removeVote(reportId: number, discordId: string): Promise<boolean> {
  const d = db();
  const [, deleted] = await d.batch([
    d
      .update(reports)
      .set({ votes: sql`max(0, ${reports.votes} - 1)` })
      .where(and(eq(reports.id, reportId), exists(voteRow(d, reportId, discordId)))),
    d
      .delete(votes)
      .where(and(eq(votes.reportId, reportId), eq(votes.discordId, discordId)))
      .returning({ reportId: votes.reportId }),
  ]);
  return deleted.length > 0;
}

/**
 * Toggles a vote.
 *
 * The removal is attempted first instead of reading the row to choose a
 * direction: it is self-guarding, so "did anything get deleted" *is* the
 * answer to "was there a vote", with no window between asking and acting.
 */
export async function toggleVote(
  reportId: number,
  discordId: string,
): Promise<'added' | 'removed'> {
  if (await removeVote(reportId, discordId)) return 'removed';
  await addVote(reportId, discordId);
  return 'added';
}

/**
 * Adds a vote without toggling — for filing a report and for resuming an
 * intent after sign-in, where a second call must never undo the first.
 */
export async function ensureVote(reportId: number, discordId: string): Promise<void> {
  await addVote(reportId, discordId);
}
