import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { readSetting } from '../../lib/settings';
import { signatureHex, verifySignature, type IssueSnapshot } from '../../lib/github';
import { syncIssues } from '../../lib/github-sync';

export const prerender = false;

/**
 * GitHub's own webhook, for the instant half of the sync.
 *
 * Paired with the reconcile rather than replacing it, because the two fail
 * differently: a webhook delivery that fails and goes unnoticed is wrong
 * forever, while a scheduled pass is late but self-correcting. Neither can
 * undo the other, because both go through syncIssues and every write there
 * no-ops when the state already matches.
 *
 * Note the content type must be `application/json` on the GitHub side. Astro's
 * checkOrigin defaults to on and rejects a cross-origin POST carrying a
 * form-like content type with a 403 *in middleware*, before this file runs — so
 * a webhook configured as x-www-form-urlencoded would fail with no way for this
 * handler to explain itself. The /admin panel says so where it is needed.
 */
export const POST: APIRoute = async (ctx) => {
  const event = ctx.request.headers.get('x-github-event');
  const header = ctx.request.headers.get('x-hub-signature-256');
  if (!signatureHex(header)) return new Response('not found', { status: 404 });

  const secret = await readSetting('github_webhook_secret');
  if (!secret) return new Response('not found', { status: 404 });

  const raw = await ctx.request.text();
  if (!(await verifySignature(secret, raw, header))) {
    return new Response('bad signature', { status: 401 });
  }

  /* The test delivery, answered only once the signature above has checked out.
     GitHub signs the ping like anything else, so verifying it first is what
     makes a green "Recent Deliveries" row mean the secret is right — answering
     before the check would have made it mean only that the URL resolves, and a
     mistyped secret would look fine until the first real close silently 401'd.
     Verified is the more useful signal, and it is the one the setup notes on
     /admin tell you to look for. */
  if (event === 'ping') return new Response('pong', { status: 200 });

  if (event !== 'issues') return new Response('ignored', { status: 202 });

  let payload: {
    action?: string;
    repository?: { full_name?: string };
    issue?: {
      number: number;
      title: string;
      state: 'open' | 'closed';
      state_reason: string | null;
      body: string | null;
      labels?: ({ name?: string } | string)[];
      created_at: string;
      updated_at: string;
      reactions?: Record<string, number>;
      pull_request?: unknown;
    };
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('bad json', { status: 400 });
  }

  // A secret shared with one repo should only ever speak for that repo.
  const repo = String(env.GITHUB_REPO ?? '');
  if (repo && payload.repository?.full_name !== repo) {
    return new Response('wrong repo', { status: 202 });
  }

  /* Closed and reopened drive the status; opened is here so an issue filed on
     GitHub rather than on the board reaches /review at once instead of waiting
     for the reconcile — the transition table returns "no change" for a newly
     opened issue, so this populates the queue without touching any status.
     Label and title edits stay ignored: they are noisy, and `state_reason`
     already carries everything the mapping reads. */
  const ACTED_ON = ['opened', 'closed', 'reopened'];
  if (!ACTED_ON.includes(String(payload.action))) {
    return new Response('ignored', { status: 202 });
  }

  const issue = payload.issue;
  // The issues event fires for pull requests too, which are not ours to track.
  if (!issue || issue.pull_request) return new Response('ignored', { status: 202 });

  const snapshot: IssueSnapshot = {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    stateReason: normaliseReason(issue.state_reason),
    body: issue.body,
    labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
    createdAt: unix(issue.created_at),
    updatedAt: unix(issue.updated_at),
    reactions: issue.reactions?.['+1'] ?? 0,
  };

  const result = await syncIssues([snapshot], { origin: ctx.url.origin });
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

const normaliseReason = (r: string | null): IssueSnapshot['stateReason'] =>
  r === 'completed' || r === 'not_planned' || r === 'duplicate' || r === 'reopened' ? r : null;
