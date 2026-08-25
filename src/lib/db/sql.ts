import { sql, type SQLWrapper } from 'drizzle-orm';

/**
 * `column IN (…)` for a list of any length, at the cost of one bound parameter.
 *
 * D1 caps bound parameters at 100 per statement and drizzle's `inArray` spends
 * one per element, so an `inArray` over the 309-entry source catalogue is a 500,
 * not a slow query. `json_each` expands a single JSON-array parameter into rows,
 * which is the pattern Cloudflare documents for this:
 * https://developers.cloudflare.com/d1/sql-api/query-json/
 *
 * Prefer drizzle's `inArray` for lists that are short by construction (statuses,
 * kinds). Reach for this one whenever the length depends on runtime data.
 */
export const inIds = (column: SQLWrapper, ids: readonly (string | number)[]) =>
  sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
