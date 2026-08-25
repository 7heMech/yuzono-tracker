/**
 * Pushes the upstream issue state into the tracker.
 *
 * Run on a schedule by .github/workflows/sync-issues.yml, and by hand for a
 * first backfill or when debugging. It reads the issues of a repo we do not
 * control — they are public, so this needs no GitHub token and no permission
 * from anyone — and posts the whole set to /github/sync signed with the shared
 * secret from /admin. All the interpreting happens there, so this stays a pipe
 * and the webhook and the reconcile cannot drift apart in how they read an
 * issue.
 *
 *   bun scripts/sync-issues.ts --dry-run
 *   bun scripts/sync-issues.ts --backfill
 *
 * Environment: TRACKER_URL, TRACKER_SYNC_SECRET, optionally GITHUB_REPO and
 * GITHUB_TOKEN (only ever to raise the anonymous rate limit; never for write).
 */

import { sign, type IssueSnapshot } from '../src/lib/github';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const backfill = args.has('--backfill');

const REPO = process.env.GITHUB_REPO ?? 'yuzono/anime-extensions';
const TRACKER = (process.env.TRACKER_URL ?? 'http://localhost:4321').replace(/\/$/, '');
const SECRET = process.env.TRACKER_SYNC_SECRET ?? '';

/* A missing secret means "not set up yet", which is a different thing from
   broken. On the schedule that has to exit cleanly, or a repo that has merged
   this but not yet generated a secret on /admin mails its owner a failure on
   every run until they do. A run somebody actually started still errors, since
   there the silence would be the confusing outcome. */
if (!dryRun && !SECRET) {
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    console.error(
      'TRACKER_SYNC_SECRET is not set, so there is nothing to sync to yet.\n' +
        'Generate one on the tracker\'s /admin page, add it to this repository as\n' +
        'a secret named TRACKER_SYNC_SECRET, and set a TRACKER_URL variable.',
    );
    process.exit(0);
  }
  throw new Error('TRACKER_SYNC_SECRET is required (or pass --dry-run)');
}

if (!dryRun && !process.env.TRACKER_URL) {
  console.error(`TRACKER_URL is not set; falling back to ${TRACKER}`);
}

type ApiIssue = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  body: string | null;
  labels: { name: string }[];
  created_at: string;
  updated_at: string;
  reactions?: Record<string, number>;
  pull_request?: unknown;
};

const headers: Record<string, string> = {
  accept: 'application/vnd.github+json',
  'user-agent': 'yuzono-tracker/sync-issues',
  'x-github-api-version': '2022-11-28',
};
// Optional and read-only. In Actions this is the workflow's own token, which is
// scoped to *this* repo and grants nothing upstream — it only buys a rate limit
// more comfortable than the anonymous 60/hour.
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const issues: IssueSnapshot[] = [];
for (let page = 1; page <= 20; page++) {
  const url = `https://api.github.com/repos/${REPO}/issues?state=all&per_page=100&page=${page}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`issues fetch failed: ${res.status} ${res.statusText}`);
  const batch = (await res.json()) as ApiIssue[];
  if (batch.length === 0) break;
  for (const iss of batch) {
    // This endpoint returns pull requests alongside issues, distinguishable
    // only by this key. Forgetting it is the classic bug here: every PR would
    // arrive looking like an issue and get matched against the catalogue.
    if (iss.pull_request) continue;
    issues.push({
      number: iss.number,
      title: iss.title,
      state: iss.state,
      stateReason: normalise(iss.state_reason),
      body: iss.body,
      labels: (iss.labels ?? []).map((l) => l.name),
      createdAt: unix(iss.created_at),
      updatedAt: unix(iss.updated_at),
      reactions: iss.reactions?.['+1'] ?? 0,
    });
  }
  if (batch.length < 100) break;
}

const open = issues.filter((i) => i.state === 'open').length;
console.error(`issues        ${issues.length} (${open} open, ${issues.length - open} closed)`);
if (backfill) console.error('backfill      fix announcements suppressed for this pass');

const body = JSON.stringify({ issues, backfill });

if (dryRun) {
  console.error(`payload       ${(body.length / 1024).toFixed(1)} KB, not sent`);
  console.log(body);
  process.exit(0);
}

const res = await fetch(`${TRACKER}/github/sync`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-tracker-signature': await sign(SECRET, body),
  },
  body,
});
const text = await res.text();
if (!res.ok) throw new Error(`tracker rejected it: ${res.status} ${text.slice(0, 300)}`);
console.error(`tracker       ${text}`);

/* A 200 can still name reconcile steps that threw — see SyncResult.failures.
   The response body says what happened either way; this turns it into a red
   run on the schedule instead of nicer scrollback nobody reads. A body that
   does not parse at all is a red run too: a truncated 200 is not a confirmed
   sync. */
let result: { failures?: string[] } | null = null;
try {
  result = JSON.parse(text);
} catch {
  console.error('tracker       invalid sync response');
  process.exit(1);
}
if (result?.failures?.length) {
  console.error(`tracker       reconcile failures: ${result.failures.join(', ')}`);
  process.exit(1);
}

function unix(iso: string) {
  return Math.floor(new Date(iso).getTime() / 1000);
}
function normalise(r: string | null): IssueSnapshot['stateReason'] {
  return r === 'completed' || r === 'not_planned' || r === 'duplicate' || r === 'reopened'
    ? r
    : null;
}
