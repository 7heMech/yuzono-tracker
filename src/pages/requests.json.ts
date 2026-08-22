import type { APIRoute } from 'astro';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../lib/db/client';
import { OPEN_STATUSES, reports } from '../lib/db/schema';
import { hostOf } from '../lib/host';

/**
 * The open source requests, for the type-ahead on /request.
 *
 * A separate file rather than hydration props, for the same reason
 * /sources.json is one: the form is used by everyone who lands on it, and the
 * list is only wanted by the minority who start typing a name. Fetched on first
 * focus, matched locally after that, so a keystroke costs nothing.
 *
 * Not prerendered — unlike the catalogue this changes between deploys, every
 * time somebody files a request. Sixty seconds at the edge is enough to keep
 * the form's own traffic off D1 while still being current enough to stop a
 * duplicate: filing one is deduplicated on the server regardless, so a stale
 * copy costs a suggestion, never a wrong write.
 *
 * Positional rows, as in /sources.json: [id, name, host, votes] with a
 * trailing 1 on the 18+ ones. Names and hosts are short, so the repeated key
 * names would be most of the bytes.
 */

export const prerender = false;

/**
 * There are ~130 open requests. The cap is a bound on the response if that
 * ever becomes ~13,000, and it drops the least-wanted rather than the newest
 * because the point of the list is to catch the sites people keep asking for.
 */
const MAX_ROWS = 500;

export const GET: APIRoute = async () => {
  const rows = await db()
    .select({
      id: reports.id,
      name: reports.proposedName,
      url: reports.proposedUrl,
      votes: reports.votes,
      nsfw: reports.nsfw,
    })
    .from(reports)
    .where(and(eq(reports.kind, 'request'), inArray(reports.status, [...OPEN_STATUSES])))
    .orderBy(desc(reports.votes))
    .limit(MAX_ROWS);

  const r = rows
    // A request with no name cannot be recognised in a list, and only the 468
    // imported rows can be in that state.
    .filter((row) => !!row.name)
    .map((row) => {
      const out: (string | number)[] = [
        row.id,
        row.name as string,
        // The host, not the stored URL: it is what the matching compares and
        // what the panel shows, and it is shorter.
        (row.url && hostOf(row.url)) || '',
        row.votes,
      ];
      if (row.nsfw) out.push(1);
      return out;
    });

  return new Response(JSON.stringify({ r }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Anonymous and identical for everyone — there is nothing per-viewer in
      // it, so it can be held at the edge like the boards are.
      'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
    },
  });
};
