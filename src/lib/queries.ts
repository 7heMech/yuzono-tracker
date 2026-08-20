import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from './db/client';
import { OPEN_STATUSES, reports, votes } from './db/schema';

export type Sort = 'demand' | 'stalled' | 'recent';

export interface BoardFilter {
  /** `bug` family (broken sources) or `request` family (wanted sources). */
  family: 'broken' | 'wanted';
  lang?: string;
  cause?: string;
  nsfw?: boolean;
  sort?: Sort;
  limit?: number;
}

const BROKEN_KINDS = ['bug', 'domain', 'dead'] as const;
const WANTED_KINDS = ['request', 'feature', 'meta', 'removal'] as const;

export async function board(f: BoardFilter) {
  const kinds = f.family === 'broken' ? BROKEN_KINDS : WANTED_KINDS;

  const where = [
    inArray(reports.kind, [...kinds]),
    inArray(reports.status, [...OPEN_STATUSES]),
  ];
  if (f.lang) where.push(eq(reports.lang, f.lang));
  if (f.cause) where.push(eq(reports.cause, f.cause as never));
  // NSFW is 35% of the catalogue, so this gate is load-bearing, not cosmetic.
  if (!f.nsfw) where.push(eq(reports.nsfw, false));

  const order =
    f.sort === 'recent'
      ? [desc(reports.createdAt)]
      : f.sort === 'stalled'
        ? // Oldest first, but weighted — a stalled item nobody wants is not
          // the same problem as a stalled item fifty people want.
          [asc(reports.createdAt), desc(reports.votes)]
        : [desc(reports.votes), asc(reports.createdAt)];

  const rows = await db()
    .select()
    .from(reports)
    .where(and(...where))
    .orderBy(...order)
    .limit(f.limit ?? 60);

  const peak = rows.reduce((m, r) => Math.max(m, r.votes), 0);
  return { rows, peak };
}

/** Everything on one source's page, newest activity first. */
export async function reportsForSource(sourceId: string) {
  return db()
    .select()
    .from(reports)
    .where(eq(reports.sourceId, sourceId))
    .orderBy(desc(reports.votes), desc(reports.createdAt));
}

/** Which of these reports has the viewer already backed? */
export async function myVotes(discordId: string, reportIds: number[]) {
  if (!reportIds.length) return new Set<number>();
  const rows = await db()
    .select({ reportId: votes.reportId })
    .from(votes)
    .where(and(eq(votes.discordId, discordId), inArray(votes.reportId, reportIds)));
  return new Set(rows.map((r) => r.reportId));
}

/** Header counters. One round trip, not four. */
export async function boardCounts() {
  const [row] = await db()
    .select({
      broken: sql<number>`sum(case when kind in ('bug','domain','dead') then 1 else 0 end)`,
      wanted: sql<number>`sum(case when kind in ('request','feature','meta','removal') then 1 else 0 end)`,
      stalled: sql<number>`sum(case when created_at < unixepoch() - 7776000 then 1 else 0 end)`,
    })
    .from(reports)
    .where(inArray(reports.status, [...OPEN_STATUSES]));
  return row ?? { broken: 0, wanted: 0, stalled: 0 };
}
