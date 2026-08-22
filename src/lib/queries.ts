import type { AstroGlobal } from 'astro';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db/client';
import { OPEN_STATUSES, reports, votes, type Report } from './db/schema';

export type Sort = 'demand' | 'stalled' | 'recent' | 'fixed';

/**
 * Which half of the backlog a board is showing: the work outstanding, or the
 * work done.
 *
 * The boards were open-only, with no way to see a fix from the site at all —
 * a report vanished the moment it was dealt with, which is the one moment the
 * person who filed it most wants to see. `fixed` is deliberately just that
 * status: `wont_fix` and `duplicate` are also closed, but neither is news.
 */
export type BoardState = 'open' | 'fixed';

/**
 * Rows per page, and the unit the pager counts in — "Next 60".
 *
 * The boards used to stop at 60 with nothing saying so, which on /requests
 * meant 77 of the 137 open requests were unreachable: the person who filed one
 * could not find it, let alone vote on it.
 */
export const PAGE_SIZE = 60;

export interface BoardFilter {
  /** `bug` family (broken sources) or `request` family (wanted sources). */
  family: 'broken' | 'wanted';
  /** Open work (the default) or fixed. */
  state?: BoardState;
  lang?: string;
  cause?: string;
  nsfw?: boolean;
  sort?: Sort;
  limit?: number;
  /** Rows to skip — the pager's position, straight off the query string. */
  offset?: number;
}

const BROKEN_KINDS = ['bug', 'domain', 'dead'] as const;
const WANTED_KINDS = ['request', 'feature', 'meta', 'removal'] as const;

/** Ninety days, which is the threshold `stalledLabel` in lib/format.ts prints. */
const STALLED_AFTER = 7_776_000;

/**
 * The columns a board row renders, and nothing else.
 *
 * `.select()` with no argument pulls all 26, `body` — the entire report text —
 * included, for rows that never show it, and the ORDER BY sorter then carries
 * that payload through a temp B-tree. These fifteen are exactly what
 * ReportRow.astro touches, `reportHeadline` (title, stage, cause) and `nsfw`
 * included.
 *
 * ReportRow's prop stays typed `Report`, so the queries below cast. The cast
 * is only honest while this list is a superset of what the component reads —
 * if a row starts showing `body` or `newUrl`, add it here in the same commit.
 */
const ROW_COLUMNS = {
  id: reports.id,
  /* So a row can say what it is. Everything on the wanted board used to read as
     a source request, including the 21 feature requests against sources that
     already exist. */
  kind: reports.kind,
  sourceId: reports.sourceId,
  // Selected so a row can say it is 18+, not just be filtered by it. The board
  // is already scoped by the toggle, but a row reached from /me, from a source
  // page or from a pasted link is not, and it used to give no indication at all.
  nsfw: reports.nsfw,
  proposedName: reports.proposedName,
  /* A request's address, which the row now prints as a host. A name alone does
     not say which site is being asked for, and /requests is 58% of the
     backlog — so scanning the board meant opening reports one at a time to
     find out. Only requests have it; on every other row it is null. */
  proposedUrl: reports.proposedUrl,
  /* So a closed row can say when it closed. Without it the fixed board dated
     every row by when it was *filed* — see fixedLabel in lib/format. */
  statusChangedAt: reports.statusChangedAt,
  lang: reports.lang,
  stage: reports.stage,
  cause: reports.cause,
  title: reports.title,
  status: reports.status,
  githubIssue: reports.githubIssue,
  votes: reports.votes,
  createdAt: reports.createdAt,
} as const;

export async function board(f: BoardFilter) {
  const kinds = f.family === 'broken' ? BROKEN_KINDS : WANTED_KINDS;

  const state = f.state ?? 'open';
  const where = [
    inArray(reports.kind, [...kinds]),
    state === 'fixed'
      ? eq(reports.status, 'fixed')
      : inArray(reports.status, [...OPEN_STATUSES]),
  ];
  if (f.lang) where.push(eq(reports.lang, f.lang));
  if (f.cause) where.push(eq(reports.cause, f.cause as never));
  // NSFW is 35% of the catalogue, so this gate is load-bearing, not cosmetic.
  // It is also the reason the two board paths differ in the query plan: with
  // 18+ on there is no equality on `nsfw`, so reports_board can only be seeked
  // on `status`.
  if (!f.nsfw) where.push(eq(reports.nsfw, false));

  /* Most recently fixed first, which is what the fixed board is for. The
     coalesce is because 468 rows came from the issue backlog already closed and
     only some carry a status_changed_at; falling back to updated_at keeps them
     in a sensible place instead of at the very end.

     The two views do not share their default, so a sort carried across in the
     query string can name an order the other view has no meaning for: `fixed`
     on the open board, `stalled` on the fixed board. Each falls back to its own
     default rather than being refused, since it arrives from a link, not from a
     control anybody pressed. */
  const sort: Sort =
    state === 'fixed'
      ? f.sort === 'demand'
        ? 'demand'
        : 'fixed'
      : f.sort === 'fixed'
        ? 'demand'
        : (f.sort ?? 'demand');

  const order =
    sort === 'fixed'
      ? [desc(sql`coalesce(${reports.statusChangedAt}, ${reports.updatedAt})`)]
      : sort === 'recent'
        ? [desc(reports.createdAt)]
        : sort === 'stalled'
          ? // Oldest first, but weighted — a stalled item nobody wants is not
            // the same problem as a stalled item fifty people want.
            [asc(reports.createdAt), desc(reports.votes)]
          : [desc(reports.votes), asc(reports.createdAt)];

  const limit = f.limit ?? PAGE_SIZE;
  const offset = Math.max(0, f.offset ?? 0);

  // The total is a second aggregate rather than `rows.length`, because the
  // pager has to say how many reports the filters match, not how many fitted
  // on this page. It costs no table reads: with the filters the boards
  // actually use it resolves to a covering count on reports_board, and it goes
  // out alongside the page rather than after it.
  const [rows, [tally]] = await Promise.all([
    db()
      .select(ROW_COLUMNS)
      .from(reports)
      .where(and(...where))
      .orderBy(...order)
      .limit(limit)
      .offset(offset),
    db()
      .select({ total: count() })
      .from(reports)
      .where(and(...where)),
  ]);

  return { rows: rows as Report[], total: tally?.total ?? 0, limit, offset };
}

/**
 * Everything one source's page shows: its open problems, then a little history.
 *
 * Open rows are ordered first so the LIMIT can only ever cut the history,
 * which is all SourceStatus.astro shows of it anyway (eight rows). This used
 * to select every column with no limit at all and took 0.92–1.16s on the live
 * site. The busiest real source in the catalogue has 16 reports and at most 2
 * open, so 40 is a cap that cannot bite in practice while still bounding the
 * query if one source ever collects a decade of history.
 */
export async function reportsForSource(sourceId: string) {
  const openFirst = sql`case when ${inArray(reports.status, [...OPEN_STATUSES])} then 0 else 1 end`;
  const rows = await db()
    .select(ROW_COLUMNS)
    .from(reports)
    .where(eq(reports.sourceId, sourceId))
    .orderBy(openFirst, desc(reports.votes), desc(reports.createdAt))
    .limit(40);
  return rows as Report[];
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

export interface BoardCounts {
  broken: number;
  wanted: number;
  brokenStalled: number;
  wantedStalled: number;
  /** Fixed, per family — the count the boards' Fixed control carries. */
  brokenFixed: number;
  wantedFixed: number;
}

/**
 * Header counters. One round trip, not four.
 *
 * Two things about the arithmetic, both of which were wrong and both of which
 * were wrong the same way — a number printed next to a list it did not
 * describe.
 *
 * Stalled is counted **per family** rather than across the whole backlog. One
 * blended figure meant the homepage printed "Stalled 90d+ 83" next to
 * "Open 75" — a stalled count larger than the open count it qualifies, in the
 * one warning colour on the page, so it was the first number anyone read and
 * it was nonsense.
 *
 * And `nsfw` is honoured, because the board it labels honours it. 18+ is 35% of
 * the catalogue and off by default, so unfiltered tallies claimed 75 broken and
 * 137 wanted while the boards listed 66 and 96 — and after pagination arrived
 * the header said "137 open requests" with "Showing 1–60 of 96" directly
 * beneath it. Whatever the board is filtering to, these count.
 *
 * Every column referenced here — status, kind, nsfw, created_at — is in
 * reports_board or reports_tallies, so the plan stays a covering index scan and
 * no report row is read to print three numbers.
 */
export async function boardCounts(nsfw = false): Promise<BoardCounts> {
  const broken = sql`kind in ('bug','domain','dead')`;
  const wanted = sql`kind in ('request','feature','meta','removal')`;
  const stalled = sql`created_at < unixepoch() - ${STALLED_AFTER}`;

  /* Open *and* fixed in one pass, split by a case rather than counted twice.
     Both status sets are a range on the same leading column of reports_board,
     so this is still one covering scan — and the alternative was a second round
     trip to D1's single primary region to print one more number. */
  const isOpen = sql`status in ('open', 'confirmed', 'in_progress')`;
  const isFixed = sql`status = 'fixed'`;

  const where = [inArray(reports.status, ['open', 'confirmed', 'in_progress', 'fixed'])];
  if (!nsfw) where.push(eq(reports.nsfw, false));

  const [row] = await db()
    .select({
      broken: sql<number>`sum(case when ${broken} and ${isOpen} then 1 else 0 end)`,
      wanted: sql<number>`sum(case when ${wanted} and ${isOpen} then 1 else 0 end)`,
      brokenStalled: sql<number>`sum(case when ${broken} and ${isOpen} and ${stalled} then 1 else 0 end)`,
      wantedStalled: sql<number>`sum(case when ${wanted} and ${isOpen} and ${stalled} then 1 else 0 end)`,
      brokenFixed: sql<number>`sum(case when ${broken} and ${isFixed} then 1 else 0 end)`,
      wantedFixed: sql<number>`sum(case when ${wanted} and ${isFixed} then 1 else 0 end)`,
    })
    .from(reports)
    .where(and(...where));

  // `sum()` over no rows is NULL, not 0, and a NULL rendered into a <dd> is a
  // blank where a number belongs.
  return {
    broken: Number(row?.broken ?? 0),
    wanted: Number(row?.wanted ?? 0),
    brokenStalled: Number(row?.brokenStalled ?? 0),
    wantedStalled: Number(row?.wantedStalled ?? 0),
    brokenFixed: Number(row?.brokenFixed ?? 0),
    wantedFixed: Number(row?.wantedFixed ?? 0),
  };
}

/* ---------------------------------------------------------------------------
   Edge caching for the two boards.

   `Cache-Control: public, s-maxage=60` on a Worker response does nothing on
   its own. Cloudflare does not store what a Worker returns unless the Worker
   writes it to the Cache API itself, or a Cache Rule says to: six requests to
   `/` came back with no `cf-cache-status` header at all and a TTFB of
   0.36–2.28s, against 0.15–0.21s of `HIT` on a genuinely prerendered page. So
   every anonymous board view ran the Worker and crossed to the single-region
   D1 primary. Do not delete the match/put below as redundant with the header:
   the header is the decorative half, and it survives only because the Cache
   API reads `s-maxage` to decide how long to keep the entry.

   Why it is shaped like this. A page cannot see its own rendered body, and
   this project has no `src/middleware.ts` to wrap `next()` in. What a page
   *can* do is render itself through `Astro.rewrite` and hold the Response that
   comes back — hence the `__fresh` marker: the rewritten pass sees it, skips
   this function and renders normally, so there is no recursion. The marker
   rides in the query string, which Astro's rewrite handler carries over
   verbatim (`copyRequest` in astro/dist/core/routing/rewrite.js), and the
   pages strip it out of every link they build.
   ------------------------------------------------------------------------ */

export const FRESH_PARAM = '__fresh';

/**
 * The cached HTML for this board, or a freshly rendered copy that has been
 * written to the cache — or null when there is no cache to use.
 *
 * **Call this only for anonymous requests.** With `mine` on every row a board
 * carries per-viewer state, so storing a signed-in render would serve one
 * person's votes to everybody who asked next. The callers gate on
 * `currentUser` being null and nothing here second-guesses them.
 *
 * Returning null means "render normally, cache nothing". That is the answer
 * whenever either the Cache API or the execution context is missing, which is
 * the same guard src/pages/vote.ts puts around `waitUntil`: no page may break
 * over a missing cache.
 *
 * **`astro dev` does provide both, and that will waste your afternoon.** The
 * Cloudflare adapter runs the dev server under Miniflare, so `caches.default`
 * and `locals.cfContext` are present and this caches locally exactly as it does
 * in production — and because the adapter is configured `persistState: true`,
 * the entries land in `.wrangler/state/v3/cache` and **survive restarting the
 * dev server**. Editing a board, or anything a board queries, and still seeing
 * the old numbers is the expected result rather than a stale module graph.
 * Clear it before trusting a board render or a screenshot — and **stop the dev
 * server first**, because Miniflare holds the backing SQLite file open and
 * deleting it underneath a running server makes every subsequent cache read
 * throw:
 *
 *     bunx astro dev stop
 *     rm -rf .wrangler/state/v3/cache
 *     bunx astro dev
 */
export async function edgeCachedRender(Astro: AstroGlobal): Promise<Response | null> {
  // `caches.default` is Cloudflare's own handle on the shared cache and is not
  // part of lib.dom, which is what astro's strict tsconfig resolves the global
  // `caches` against — hence the cast. The `typeof` guard comes first because
  // under `astro dev` the global is absent altogether.
  const cache =
    typeof caches === 'undefined'
      ? undefined
      : (caches as unknown as { default: Cache }).default;
  const cf = Astro.locals.cfContext;
  if (!cache || !cf) return null;

  // The whole query string is part of the key: the language, the cause, the
  // 18+ toggle, the sort and now the pager offset all live there, and none of
  // those renders may be served for another.
  const key = new Request(Astro.url.toString(), { method: 'GET' });

  // The read is allowed to fail, for the same reason the write below is: this
  // is a cache, and a board that only works while the cache is healthy is
  // worse than one that has no cache at all. Without this the homepage
  // returned 500 — `cache.match` threw `SQLITE_CANTOPEN` from inside
  // Miniflare after its backing file was removed underneath a running dev
  // server, and the error propagated straight out of the page.
  let hit: Response | undefined;
  try {
    hit = await cache.match(key);
  } catch {
    return null;
  }
  if (hit) return hit;

  const fresh = new URL(Astro.url);
  fresh.searchParams.set(FRESH_PARAM, '1');
  const rendered = await Astro.rewrite(fresh);

  // A response that sets a cookie is per-visitor by definition, and the Cache
  // API refuses to store one anyway; anything that is not a 200 is not worth
  // keeping for a minute. `waitUntil` so the visitor is not made to wait for
  // the write, and the put is allowed to fail quietly — a cache that is full
  // or unavailable is not a reason to fail the page.
  if (rendered.status === 200 && !rendered.headers.has('set-cookie')) {
    cf.waitUntil(cache.put(key, rendered.clone()).catch(() => {}));
  }
  return rendered;
}
