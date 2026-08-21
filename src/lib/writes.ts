import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db/client';
import { OPEN_STATUSES, reports } from './db/schema';

/**
 * Guards shared by the three write paths (/new, /request, /vote).
 *
 * They live together because each one exists to stop the same class of
 * problem: a write that the form's own validation has no opinion about —
 * a report id that names nothing, a host comparison that matches too much,
 * a signed-in account filing faster than a person could.
 */

/* --- filing cooldown ----------------------------------------------------- */

/**
 * How many reports one account may file per hour before we ask it to wait.
 *
 * There is no general rate limiter here on purpose. Bug reports are already
 * bounded by the unique index — the second person to hit a breakage upvotes
 * instead of inserting — so the only genuinely uncapped filing path is
 * /request, where a varied name defeats the dedupe every time. Counting the
 * account's own recent rows costs one indexed read (reports_by_reporter) and
 * needs no KV namespace, no Turnstile, and nothing to expire; a handful an
 * hour is well above what an honest reporter does and well below what a loop
 * does. It bounds *inserts* only: joining an existing report is a vote, and
 * votes are bounded by the vote row itself.
 */
export const FILING_LIMIT = 6;
export const FILING_WINDOW_SECONDS = 3600;

/** Said on the form rather than raised as an error — being early is not a fault. */
export const FILING_COOLDOWN_MESSAGE =
  "You've filed several reports in the last hour — give it a bit before the next one.";

export async function overFilingLimit(reporterId: string): Promise<boolean> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)` })
    .from(reports)
    .where(
      and(
        eq(reports.reporterId, reporterId),
        // Compared in SQLite's own clock rather than the worker's, because
        // created_at is written by `unixepoch()` and the two need not agree.
        sql`${reports.createdAt} > unixepoch() - ${FILING_WINDOW_SECONDS}`,
      ),
    );
  return (row?.n ?? 0) >= FILING_LIMIT;
}

/* --- vote targets -------------------------------------------------------- */

/**
 * A report id has to survive being a foreign key, so it is checked before it is
 * ever stored: `Number(null)` is 0 and `Number.isInteger(0)` is true, which is
 * how a missing form field used to reach the database as a vote for report 0.
 */
export const isReportId = (n: number) => Number.isSafeInteger(n) && n > 0;

/**
 * Whether this report exists and still counts as live demand.
 *
 * Checked *before* an anonymous vote is remembered for after sign-in: a vote
 * stashed for a report that cannot be voted on is a session value that makes
 * every future sign-in fail, and the cheapest place to refuse it is here.
 */
export async function isVotableReport(reportId: number): Promise<boolean> {
  const [row] = await db()
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.id, reportId), inArray(reports.status, [...OPEN_STATUSES])));
  return !!row;
}

/* --- addresses ----------------------------------------------------------- */

/**
 * The comparable host of an address: lowercased, no leading `www.`, no path.
 *
 * Requests are deduplicated on this and nothing else. The previous test was
 * `stored.includes(host)`, which is wrong twice over: innocently, because
 * `'https://anime.com'.includes('e.com')` is true, so a request for e.com was
 * swallowed by an unrelated one; and deliberately, because a stored address of
 * `https://evil.example/animefire.plus/hianime.to` contains the host of every
 * site someone might later ask for, and would have absorbed each of those
 * requests — and their votes — into itself. Only equality of the host is safe,
 * and it must be parsed back out because normaliseUrl keeps the path.
 */
export function hostOf(url: string): string | null {
  const v = url.trim();
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.host.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** True only when both addresses parse and name the same host. */
export function sameHost(a: string, b: string): boolean {
  const x = hostOf(a);
  return x !== null && x === hostOf(b);
}
