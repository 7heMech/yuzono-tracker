import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from './db/client';
import { githubIssues, reports, users } from './db/schema';
import { announceFixed } from './webhook';
import { notifyWatchers } from './notify';
import { logAction } from './staff';
import { readConfig, type Config } from './settings';
import { SOURCES } from './sources';
import {
  classifyIssue,
  promoteTitle,
  type PromotableReport,
  reportIdFromBody,
  transitionFor,
  type IssueSnapshot,
  type Status,
} from './github';

/**
 * The database half of the GitHub sync.
 *
 * Split from lib/github.ts so that the signature check and the transition
 * table stay in a module with no path to `cloudflare:workers`, and can be
 * tested without stubbing it. Everything here needs D1.
 *
 * Both entry points — the scheduled reconcile and the webhook — funnel into
 * `syncIssues` so neither can develop its own idea of what an issue means.
 */

/**
 * Audit rows need an actor and the sync has no session. A fixed synthetic
 * identity is better than omitting the row: "who closed this report" is the
 * first question asked when one looks wrong, and "GitHub sync" is a real and
 * useful answer.
 */
export const SYNC_ACTOR = { id: 'github', username: 'GitHub sync' } as const;

/** Whoever is credited in the audit log — a moderator, or the sync itself. */
type Actor = { id: string; username: string };

/** How many fix announcements one pass may send. See drainAnnouncements. */
const ANNOUNCE_PER_PASS = 5;

/**
 * How recent a fix has to be to be worth announcing. A fix that landed months
 * ago is not news, and this is what makes flooding the channel structurally
 * impossible rather than a thing an operator has to remember to avoid: the
 * seeded backlog alone holds hundreds of reports already marked fixed and never
 * announced, and without this the first ordinary pass would start working
 * through them five at a time, forever.
 */
const ANNOUNCE_MAX_AGE = 60 * 60 * 24;

export interface SyncOptions {
  origin: string;
  /**
   * Suppress fix announcements by pre-claiming them. For the first run only:
   * that pass closes hundreds of reports whose fixes shipped months ago, and
   * announcing them would bury the channel.
   */
  backfill?: boolean;
  /** Skip creating reports for unmatched issues; only sync what is linked. */
  linkOnly?: boolean;
}

export interface SyncResult {
  seen: number;
  changed: number;
  adopted: number;
  linked: number;
  review: number;
  announced: number;
  /** Rows whose 18+ flag was corrected this pass. See reconcileNsfw. */
  reflagged: number;
}

export async function syncIssues(
  snapshots: IssueSnapshot[],
  opts: SyncOptions,
): Promise<SyncResult> {
  const cfg = await readConfig();

  // Backfill claims every outstanding fix announcement up front, not only the
  // ones this pass is about to create. On a database seeded from the old issue
  // backlog most already-fixed reports have never been announced, and they are
  // just as unwelcome in the channel as the ones being closed right now.
  if (opts.backfill) {
    await db()
      .update(reports)
      .set({ fixAnnouncedAt: sql`(unixepoch())` })
      .where(and(eq(reports.status, 'fixed'), isNull(reports.fixAnnouncedAt)));
  }

  const result: SyncResult = {
    seen: 0,
    changed: 0,
    adopted: 0,
    linked: 0,
    review: 0,
    announced: 0,
    reflagged: 0,
  };

  /* Read once per pass, not once per issue. A reconcile carries every upstream
     issue, so anything queried inside the loop below is paid ~470 times — and
     this list is almost always empty, holding only reports a moderator promoted
     whose issue has not come back to us yet. */
  const awaitingIssue = await db()
    .select({
      id: reports.id,
      kind: reports.kind,
      title: reports.title,
      lang: reports.lang,
      sourceId: reports.sourceId,
      proposedName: reports.proposedName,
      stage: reports.stage,
      cause: reports.cause,
    })
    .from(reports)
    .where(and(isNotNull(reports.promotedAt), isNull(reports.githubIssue)));

  for (const issue of snapshots) {
    result.seen++;
    const [prior] = await db()
      .select()
      .from(githubIssues)
      .where(eq(githubIssues.number, issue.number));

    let reportId = prior?.reportId ?? null;

    // Resolve to a report if we do not already know one. Order matters: an
    // explicit link beats a backlink, and a backlink beats a guess.
    if (reportId === null) {
      const resolved = await resolveReport(issue, opts, awaitingIssue);
      reportId = resolved.reportId;
      if (resolved.outcome === 'adopted') result.adopted++;
      else if (resolved.outcome === 'linked') result.linked++;
      else result.review++;
    }

    // The transition, from what we saw last time to what we see now. Never
    // from comparing our status to theirs — see transitionFor.
    const wanted = transitionFor(prior?.state ?? null, issue.state, issue.stateReason);
    if (reportId !== null && wanted) {
      const applied = await applyStatus(reportId, wanted, opts);
      if (applied) result.changed++;
    }

    /* Written last, so a crash before this point leaves the same transition
       waiting to be re-read next pass rather than swallowing it — but skipped
       when nothing about the issue has changed at all. A reconcile carries all
       ~470 issues at once, so writing every row each pass would spend hundreds
       of D1 writes to record that nothing happened. */
    const unchanged =
      prior &&
      prior.state === issue.state &&
      prior.stateReason === issue.stateReason &&
      prior.title === issue.title &&
      prior.updatedAt === issue.updatedAt &&
      prior.reportId === reportId;
    if (unchanged) continue;

    await db()
      .insert(githubIssues)
      .values({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        stateReason: issue.stateReason,
        updatedAt: issue.updatedAt,
        labels: JSON.stringify(issue.labels),
        reactions: issue.reactions,
        reportId,
        seenAt: sql`(unixepoch())`,
      })
      .onConflictDoUpdate({
        target: githubIssues.number,
        set: {
          title: issue.title,
          state: issue.state,
          stateReason: issue.stateReason,
          updatedAt: issue.updatedAt,
          labels: JSON.stringify(issue.labels),
          reactions: issue.reactions,
          // Only ever fills a gap. A moderator's manual link must not be
          // undone by a later pass whose own matching came up empty.
          ...(reportId !== null ? { reportId } : {}),
          seenAt: sql`(unixepoch())`,
        },
      });
  }

  result.reflagged = await reconcileNsfw(SYNC_ACTOR);
  result.announced = await drainAnnouncements(opts.origin, cfg);
  return result;
}

/* --- the 18+ flag --------------------------------------------------------- */

/**
 * Re-derives `reports.nsfw` for every row that has an authority to derive it
 * from, and returns how many rows moved.
 *
 * Why this exists at all. `applyStatus` is the only thing a pass used to write
 * to a linked report, so every catalogue-derived column was frozen at the
 * moment the report was created and nothing could ever correct it. Two
 * consequences, both of which were live: the 468 rows from the original import
 * carried a flag taken from a GitHub label rather than the catalogue, so 46 of
 * the 174 catalogue-backed rows disagreed with the catalogue and 45 adult
 * sources sat on the default board; and adding an `18+` label upstream, or
 * upstream flipping a source's flag in the extension index, changed nothing
 * here no matter how many passes ran.
 *
 * Deliberately set-based rather than per-issue. The loop above is paid roughly
 * 470 times a pass, and doing this there would mean a read per issue to learn
 * a `source_id` this can get in bulk. These are four statements whose cost does
 * not grow with the number of issues, and because they are driven by the
 * catalogue rather than by the issues in the payload, they also repair rows
 * whose issue was not in this pass at all.
 *
 * The rule differs by whether there is a catalogue entry, because the authority
 * differs — see nsfwFor in lib/github.ts:
 *
 *   - A row with a `source_id` in the catalogue: the catalogue decides, both
 *     ways. There is nothing to preserve, because no human input goes into that
 *     value; the moderator control on /report is gated to catalogue-less rows
 *     for exactly this reason.
 *   - A row with no catalogue entry — a source request, or an adopted issue
 *     whose source could not be matched: the GitHub label may only ever turn
 *     the flag *on*. Asymmetric on purpose. The alternative is a label removal
 *     silently undoing a moderator who marked something 18+ by hand, and
 *     between over- and under-marking an adult source, over-marking is the
 *     mistake to prefer. A moderator can still turn it off, and that decision
 *     survives every later pass.
 */
export async function reconcileNsfw(actor: Actor): Promise<number> {
  const adult = SOURCES.filter((s) => s.nsfw).map((s) => s.id);
  const tame = SOURCES.filter((s) => !s.nsfw).map((s) => s.id);
  const d = db();

  // `inArray` with ~200 ids is one bound parameter each, well inside SQLite's
  // default limit of 32766, so these stay single statements.
  const [on, off] = await Promise.all([
    adult.length
      ? d
          .update(reports)
          .set({ nsfw: true, updatedAt: sql`(unixepoch())` })
          .where(and(inArray(reports.sourceId, adult), eq(reports.nsfw, false)))
          .returning({ id: reports.id })
      : Promise.resolve([]),
    tame.length
      ? d
          .update(reports)
          .set({ nsfw: false, updatedAt: sql`(unixepoch())` })
          .where(and(inArray(reports.sourceId, tame), eq(reports.nsfw, true)))
          .returning({ id: reports.id })
      : Promise.resolve([]),
  ]);

  /* Catalogue-less rows, from the label we already stored. `labels` is a JSON
     array in a text column, so the test is a substring against the quoted
     value — `"18+"` cannot appear inside any other label GitHub allows, since
     the quotes are the JSON delimiters. Only ever sets the flag; see above. */
  const labelled = await d
    .update(reports)
    .set({ nsfw: true, updatedAt: sql`(unixepoch())` })
    .where(
      and(
        isNull(reports.sourceId),
        eq(reports.nsfw, false),
        sql`EXISTS (
          SELECT 1 FROM github_issues gi
          WHERE gi.report_id = ${reports.id} AND gi.labels LIKE '%"18+"%'
        )`,
      ),
    )
    .returning({ id: reports.id });

  const moved = on.length + off.length + labelled.length;

  /* Audited, because a report quietly moving on or off the default board is
     exactly the kind of change someone later asks about — and a count is
     enough, since the ids are recoverable from the catalogue. Silent when
     nothing moved, which is every pass after the first. */
  if (moved > 0) {
    await logAction(
      actor,
      'sync.nsfw',
      null,
      `${on.length} marked 18+, ${off.length} cleared, ${labelled.length} from labels`,
    );
  }
  return moved;
}

/* --- resolving ------------------------------------------------------------ */

type Resolution = { reportId: number | null; outcome: 'linked' | 'adopted' | 'review' };

async function resolveReport(
  issue: IssueSnapshot,
  opts: SyncOptions,
  awaitingIssue: PromotableReport[],
): Promise<Resolution> {
  const d = db();

  // 1. Already linked from the other side — a report carrying this number.
  const [byNumber] = await d
    .select({ id: reports.id })
    .from(reports)
    .where(eq(reports.githubIssue, issue.number));
  if (byNumber) return { reportId: byNumber.id, outcome: 'linked' };

  // 2. The backlink promoteUrl planted in the body. The strong signal, because
  //    it is exact and we put it there.
  const backlink = reportIdFromBody(issue.body);
  if (backlink !== null) {
    const linked = await claimIssueFor(backlink, issue.number);
    if (linked) return { reportId: backlink, outcome: 'linked' };
  }

  // 3. A report this moderator promoted, recognised by the title we generated.
  //    The fallback for when the backlink did not survive the issue form.
  const titled = awaitingIssue.find((r) => promoteTitle(r) === issue.title);
  if (titled) {
    const linked = await claimIssueFor(titled.id, issue.number);
    if (linked) return { reportId: titled.id, outcome: 'linked' };
  }

  if (opts.linkOnly) return { reportId: null, outcome: 'review' };

  // 4. Guess from the title and labels.
  const c = classifyIssue(issue);
  if (!c.confident || !c.sourceId) return { reportId: null, outcome: 'review' };

  // Any open report against the same source sends this to a moderator, even
  // when the problem keys differ. Checking source *and* problem would look
  // tighter and be worse: a tracker report filed as `no-video` and an issue
  // whose labels resolve to `other` are the same breakage but do not collide,
  // so the pair would quietly become two reports splitting one vote count.
  const open = await d
    .select({ id: reports.id, problem: reports.problem })
    .from(reports)
    .where(
      and(
        eq(reports.sourceId, c.sourceId),
        sql`${reports.status} IN ('open', 'confirmed', 'in_progress')`,
      ),
    );
  if (open.length > 0) {
    const same = open.find((r) => r.problem === c.problem);
    if (same) {
      const linked = await claimIssueFor(same.id, issue.number);
      if (linked) return { reportId: same.id, outcome: 'linked' };
    }
    return { reportId: null, outcome: 'review' };
  }

  return adopt(issue, c);
}

/**
 * Writes github_issue onto a report, but only if it is still free. The unique
 * partial index makes a race here an error rather than a silent overwrite, so
 * the guard is `IS NULL` and the caller treats a miss as "send it to review".
 */
async function claimIssueFor(reportId: number, number: number): Promise<boolean> {
  const [row] = await db()
    .update(reports)
    .set({ githubIssue: number, updatedAt: sql`(unixepoch())` })
    .where(and(eq(reports.id, reportId), isNull(reports.githubIssue)))
    .returning({ id: reports.id });
  return !!row;
}

/** Creates a report for an issue nobody filed here. */
async function adopt(
  issue: IssueSnapshot,
  c: ReturnType<typeof classifyIssue>,
): Promise<Resolution> {
  await ensureSyncUser();
  try {
    const [row] = await db()
      .insert(reports)
      .values({
        kind: c.kind,
        sourceId: c.sourceId,
        proposedName: c.proposedName,
        lang: c.lang,
        nsfw: c.nsfw,
        stage: c.stage,
        cause: c.cause,
        problem: c.problem,
        title: c.title,
        status: issue.state === 'closed' ? 'fixed' : 'open',
        reporterId: SYNC_ACTOR.id,
        githubIssue: issue.number,
        // The 👍 count plus the person who filed it, which is what the original
        // backlog import used and keeps adopted rows comparable to seeded ones.
        votes: issue.reactions + 1,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      })
      .returning({ id: reports.id });
    if (!row) return { reportId: null, outcome: 'review' };
    await logAction(SYNC_ACTOR, 'issue.adopt', String(row.id), `#${issue.number}`);
    return { reportId: row.id, outcome: 'adopted' };
  } catch {
    // The partial unique indexes are the real backstop against a bad guess:
    // rather than trusting the matching to be perfect, let SQLite refuse a
    // duplicate and put the issue in front of a moderator.
    return { reportId: null, outcome: 'review' };
  }
}

/**
 * The reporter for adopted rows. `reports.reporter_id` is a notNull foreign
 * key, so there has to be a row; this is the same placeholder-user move
 * /admin already makes when granting staff to someone who has never signed in.
 */
async function ensureSyncUser() {
  await db()
    .insert(users)
    .values({ discordId: SYNC_ACTOR.id, username: SYNC_ACTOR.username, accountCreatedAt: 0 })
    .onConflictDoNothing();
}

/* --- applying ------------------------------------------------------------- */

/**
 * Moves one report, and only if it is actually moving. That no-op is what makes
 * every path here idempotent: a webhook redelivery, an overlapping reconcile
 * and a manual re-run all land on the same state without a dedupe table, a
 * delivery-id log or a time window.
 */
async function applyStatus(
  reportId: number,
  status: Status,
  opts: SyncOptions,
): Promise<boolean> {
  const [updated] = await db()
    .update(reports)
    .set({
      status,
      statusChangedAt: sql`(unixepoch())`,
      updatedAt: sql`(unixepoch())`,
      // Pre-claim the fix announcement so the draining step skips it. Same
      // column announceFixed claims, so one write suppresses it once and
      // permanently, with nothing new to remember.
      ...(opts.backfill && status === 'fixed'
        ? { fixAnnouncedAt: sql`(unixepoch())` }
        : {}),
    })
    .where(and(eq(reports.id, reportId), sql`${reports.status} <> ${status}`))
    .returning({ id: reports.id });
  if (!updated) return false;

  await logAction(SYNC_ACTOR, 'report.status', String(reportId), status);
  // Actor null: nobody here is the actor, so everyone watching should hear.
  await notifyWatchers(reportId, 'status_changed', status, null);
  return true;
}

/**
 * Announces fixes as a separate draining step rather than inside applyStatus.
 *
 * Announcing inline would be subtly broken: applyStatus no-ops when the status
 * already matches, so a report whose Discord post failed once would never be
 * revisited and would simply never be announced. Selecting on the claim column
 * instead means an unsent announcement stays owed and goes out on a later pass.
 *
 * The cap is what respects Discord's rate limit without a sleep loop: whatever
 * is over it stays unclaimed and drains next time.
 */
async function drainAnnouncements(origin: string, cfg: Config): Promise<number> {
  // Retire anything too old to announce, whether or not Discord is configured.
  // Claiming without sending is what stops a months-old backlog from queueing
  // up behind the cap and trickling out one handful per pass. It runs even with
  // no webhook set so that turning announcements on later does not release a
  // flood of history.
  await db()
    .update(reports)
    .set({ fixAnnouncedAt: sql`(unixepoch())` })
    .where(
      and(
        eq(reports.status, 'fixed'),
        isNull(reports.fixAnnouncedAt),
        sql`(${reports.statusChangedAt} IS NULL OR ${reports.statusChangedAt} < unixepoch() - ${ANNOUNCE_MAX_AGE})`,
      ),
    );

  if (!cfg.webhook_url || cfg.webhook_on_fixed !== '1') return 0;
  const owed = await db()
    .select()
    .from(reports)
    .where(and(eq(reports.status, 'fixed'), isNull(reports.fixAnnouncedAt)))
    .limit(ANNOUNCE_PER_PASS);
  let sent = 0;
  for (const report of owed) {
    // Sequential on purpose: one webhook, and a burst of parallel posts is how
    // you get rate-limited. Passing cfg avoids a config read per announcement.
    const res = await announceFixed(report, origin, cfg);
    if (res) sent++;
  }
  return sent;
}

/* --- queue reads ---------------------------------------------------------- */

/** Issues with no report, awaiting a moderator. */
export const needsReview = () =>
  db()
    .select()
    .from(githubIssues)
    .where(and(isNull(githubIssues.reportId), isNull(githubIssues.dismissedAt)))
    .orderBy(sql`${githubIssues.number} desc`)
    .limit(100);

/**
 * Reports we call done whose issue is still open upstream. Expected to be
 * non-empty in normal running: with no write access the tracker cannot close
 * anything, so this is a list of things for someone to close by hand.
 */
export const mismatches = () =>
  db()
    .select({
      number: githubIssues.number,
      title: githubIssues.title,
      reportId: reports.id,
      status: reports.status,
    })
    .from(githubIssues)
    .innerJoin(reports, eq(reports.id, githubIssues.reportId))
    .where(and(eq(githubIssues.state, 'open'), sql`${reports.status} IN ('fixed', 'wont_fix', 'duplicate')`))
    .limit(100);

export const pendingReviewCount = async () => {
  const [row] = await db()
    .select({ n: sql<number>`count(*)` })
    .from(githubIssues)
    .where(and(isNull(githubIssues.reportId), isNull(githubIssues.dismissedAt)));
  return row?.n ?? 0;
};

/* --- moderator actions ---------------------------------------------------- */

/**
 * Rebuilds the snapshot /review needs from the stored row, so adopting an issue
 * a moderator has judged does not have to call the GitHub API from inside a
 * page render.
 */
export function snapshotOf(row: {
  number: number;
  title: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: string | null;
  reactions: number;
  updatedAt: number | null;
}): IssueSnapshot {
  let labels: string[] = [];
  try {
    const parsed = row.labels ? JSON.parse(row.labels) : [];
    if (Array.isArray(parsed)) labels = parsed.filter((l): l is string => typeof l === 'string');
  } catch {
    // A malformed row should cost this one issue its labels, not the page.
  }
  return {
    number: row.number,
    title: row.title,
    state: row.state,
    stateReason: (row.stateReason ?? null) as IssueSnapshot['stateReason'],
    body: null,
    labels,
    createdAt: row.updatedAt ?? 0,
    updatedAt: row.updatedAt ?? 0,
    reactions: row.reactions,
  };
}

/** Attach an issue to a report a moderator picked. */
export async function linkIssue(number: number, reportId: number, actor: Actor) {
  const [report] = await db().select({ id: reports.id }).from(reports).where(eq(reports.id, reportId));
  if (!report) return { ok: false as const, error: `There is no report #${reportId}.` };
  if (!(await claimIssueFor(reportId, number))) {
    return { ok: false as const, error: `Report #${reportId} is already linked to another issue.` };
  }
  await db()
    .update(githubIssues)
    .set({ reportId, dismissedAt: null })
    .where(eq(githubIssues.number, number));
  await logAction(actor, 'issue.link', String(number), `report ${reportId}`);
  return { ok: true as const };
}

/** File the report this issue should have had. */
export async function adoptIssue(number: number, actor: Actor) {
  const [row] = await db().select().from(githubIssues).where(eq(githubIssues.number, number));
  if (!row) return { ok: false as const, error: 'That issue is no longer in the queue.' };
  const snapshot = snapshotOf(row);
  const c = classifyIssue(snapshot);
  if (!c.sourceId) {
    return {
      ok: false as const,
      error: 'No catalogue source could be identified, so there is nothing to file this against. Link it to an existing report instead.',
    };
  }
  const res = await adopt(snapshot, c);
  if (res.reportId === null) {
    return {
      ok: false as const,
      error: 'A report for that source and problem already exists. Link this issue to it instead.',
    };
  }
  await db()
    .update(githubIssues)
    .set({ reportId: res.reportId, dismissedAt: null })
    .where(eq(githubIssues.number, number));
  await logAction(actor, 'issue.adopt', String(number), `report ${res.reportId}`);
  return { ok: true as const, reportId: res.reportId };
}

/** Take an issue out of the queue without filing anything. */
export async function dismissIssue(number: number, actor: Actor) {
  await db()
    .update(githubIssues)
    .set({ dismissedAt: sql`(unixepoch())` })
    .where(eq(githubIssues.number, number));
  await logAction(actor, 'issue.dismiss', String(number), null);
  return { ok: true as const };
}
