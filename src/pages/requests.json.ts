import type { APIRoute } from 'astro';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../lib/db/client';
import { OPEN_STATUSES, reports } from '../lib/db/schema';
import { hostOf } from '../lib/host';
import { getSource } from '../lib/sources';

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
 * Two arrays, not one list of mixed shapes:
 *
 *   r — source requests. [id, name, host, votes] with a trailing 1 on the 18+
 *       ones. This is what the request form's twin detection reads, and it has
 *       to keep reading exactly what it read before.
 *   f — feature requests against a source that already exists.
 *       [id, sourceId, name, ask, votes] on the same trailing-1 rule, where
 *       `name` is the catalogue's name for the source and `ask` is the stored
 *       title. The id is carried because the request form filters these by the
 *       source somebody has just picked, and a name is not a key: the catalogue
 *       has sources whose names differ only by language.
 *
 * Positional, as in /sources.json: names, hosts and short asks would otherwise
 * be outweighed by their own repeated key names.
 */

export const prerender = false;

/**
 * There are ~130 open requests. The cap is a bound on the response if that
 * ever becomes ~13,000, and it drops the least-wanted rather than the newest
 * because the point of the list is to catch the sites people keep asking for.
 */
const MAX_ROWS = 500;

export const GET: APIRoute = async () => {
  // Each kind capped independently so a surge of one cannot starve the other:
  // RequestFinder deduplicates on `r`, so even the lowest-voted source request
  // must still be present when the table grows past MAX_ROWS.
  const baseSelect = {
    id: reports.id,
    kind: reports.kind,
    sourceId: reports.sourceId,
    name: reports.proposedName,
    url: reports.proposedUrl,
    title: reports.title,
    votes: reports.votes,
    nsfw: reports.nsfw,
  } as const;
  const [requestRows, featureRows] = await Promise.all([
    db()
      .select(baseSelect)
      .from(reports)
      .where(and(eq(reports.kind, 'request'), inArray(reports.status, [...OPEN_STATUSES])))
      .orderBy(desc(reports.votes))
      .limit(MAX_ROWS),
    db()
      .select(baseSelect)
      .from(reports)
      .where(and(eq(reports.kind, 'feature'), inArray(reports.status, [...OPEN_STATUSES])))
      .orderBy(desc(reports.votes))
      .limit(MAX_ROWS),
  ]);

  /* Feature rows: the display name comes from the catalogue for 18 of the 21
     and from proposed_name for the rest — the same fallback the board row uses,
     so the two surfaces name a source the same way. */
  const f = featureRows.map((row) => {
    const name = getSource(row.sourceId)?.name ?? row.name ?? 'Unknown source';
    const out: (string | number)[] = [
      row.id,
      // '' on the three rows that name a source the import could not match.
      row.sourceId ?? '',
      name,
      row.title,
      row.votes,
    ];
    if (row.nsfw) out.push(1);
    return out;
  });

  const r = requestRows
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

  return new Response(JSON.stringify({ r, f }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Anonymous and identical for everyone — there is nothing per-viewer in
      // it, so it can be held at the edge like the boards are.
      'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
    },
  });
};
