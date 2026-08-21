import type { User } from './db/schema';

/**
 * The three kinds of reporter the backlog and the sync produce.
 *
 * - '0'      — synthetic imported-from-github, owns the 468 seeded rows.
 * - 'github' — SYNC_ACTOR from lib/github-sync.ts, for issues the sync adopted.
 * - other    — a real Discord snowflake, present in users.
 *
 * Both the page (`on Anikura · filed by …`) and the Discord announcement
 * (`Filed by: …`) need the same answer, or they disagree. This module is the
 * single answer.
 */

export interface ReporterMeta {
  /** What the page shows. */
  display: string;
  /** What Discord renders: a mention if mentionable, plain text otherwise. */
  mention: string;
  /** Whether `<@id>` would actually ping. */
  mentionable: boolean;
}

/**
 * One branch, two surfaces.
 *
 * Called with a report row's `reporterId` and, when a real user is expected,
 * the `users` row for that id (from `dbUser`). The two synthetic ids never
 * need a lookup, which is what keeps a board row cheap — adding users to every
 * ROW_COLUMNS query would cost more than it tells.
 */
export function reporterMeta(
  reporterId: string,
  user?: Pick<User, 'username'> | null,
): ReporterMeta {
  if (reporterId === '0') {
    return { display: 'imported from GitHub', mention: 'imported from GitHub', mentionable: false };
  }
  if (reporterId === 'github') {
    return { display: 'opened on GitHub', mention: 'opened on GitHub', mentionable: false };
  }
  const name = user?.username ?? 'unknown';
  return { display: name, mention: `<@${reporterId}>`, mentionable: true };
}

/** Convenience when only the display string is needed. */
export function reporterDisplay(reporterId: string, user?: Pick<User, 'username'> | null): string {
  return reporterMeta(reporterId, user).display;
}

/** Convenience for the webhook payload. */
export function reporterMention(reporterId: string, user?: Pick<User, 'username'> | null): string {
  return reporterMeta(reporterId, user).mention;
}
