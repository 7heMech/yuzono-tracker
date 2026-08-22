import type { User } from './db/schema';

/**
 * Who filed a report, in the one wording every surface uses.
 *
 * The backlog produces three kinds of reporter:
 *
 * - '0'      — synthetic imported-from-github, owns the 468 seeded rows.
 * - 'github' — SYNC_ACTOR from lib/github-sync.ts, for issues the sync adopted.
 * - other    — a real Discord snowflake, present in users.
 *
 * Both the page (`on Anikura · filed by …`) and the Discord announcement
 * (`Filed by: …`) need the same answer, or they disagree. This module is the
 * single answer.
 *
 * It used to hand Discord a `<@id>` mention instead of the name, and that is
 * why the announcement read "Filed by: 297145..." in the channel. A client
 * renders a mention by looking the id up in the message's `mentions` array,
 * which a webhook post only carries for ids it was allowed to ping — and these
 * posts allow none (`allowed_mentions: { parse: [] }` in lib/webhook.ts, so
 * filing a report cannot ping anybody). With nothing to resolve against, and no
 * guarantee the reader's client has that member cached, the raw snowflake is
 * all Discord can show. We already store the username at login, so the
 * announcement says it in plain text — the same string the report page shows.
 */

const SYNTHETIC: Record<string, string> = {
  '0': 'imported from GitHub',
  github: 'opened on GitHub',
};

/** Whether this id names a Discord account rather than one of the two synthetic ones. */
export const isRealAccount = (reporterId: string) => !Object.hasOwn(SYNTHETIC, reporterId);

export interface ReporterMeta {
  /** What every surface shows. */
  display: string;
}

/**
 * One branch, two surfaces.
 *
 * Called with a report row's `reporterId` and, when a real account is expected,
 * the `users` row for that id (from `dbUser`). The two synthetic ids never need
 * a lookup, which is what keeps a board row cheap — adding users to every
 * ROW_COLUMNS query would cost more than it tells.
 */
export function reporterMeta(
  reporterId: string,
  user?: Pick<User, 'username'> | null,
): ReporterMeta {
  const synthetic = SYNTHETIC[reporterId];
  if (synthetic) return { display: synthetic };
  return { display: user?.username ?? 'unknown' };
}

/**
 * The display name, reading `users` only when there is an account to read.
 *
 * Takes the loader rather than importing `dbUser`, so this module stays free of
 * the database (and therefore of `cloudflare:workers`) and can be tested on its
 * own. Callers pass `dbUser` from lib/auth.
 */
export async function reporterName(
  reporterId: string,
  load: (id: string) => Promise<Pick<User, 'username'> | undefined>,
): Promise<string> {
  const user = isRealAccount(reporterId) ? await load(reporterId) : null;
  return reporterMeta(reporterId, user).display;
}
