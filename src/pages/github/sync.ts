import type { APIRoute } from 'astro';
import { readSetting } from '../../lib/settings';
import { signatureHex, verifySignature, type IssueSnapshot } from '../../lib/github';
import { syncIssues } from '../../lib/github-sync';

export const prerender = false;

/**
 * Reconciliation endpoint, called by .github/workflows/sync-issues.yml.
 *
 * The workflow reads the upstream issues — they are public, so no GitHub token
 * is involved anywhere — and posts the full set here, signed with the shared
 * secret from /admin. The tracker does all the interpreting, so the workflow
 * stays a dumb pipe and the mapping lives in one place with the webhook.
 *
 * Full state every run rather than a `since` window: a cursor that gets stuck
 * stops syncing silently, whereas a full pass self-heals. Re-sending the same
 * state is free because every write here is a no-op when nothing moved.
 */
export const POST: APIRoute = async (ctx) => {
  // Shape-check the signature before anything else. This route is public and
  // unauthenticated by nature, so a garbage request must not reach D1 — without
  // this, anyone could bill us a database read per request.
  const header = ctx.request.headers.get('x-tracker-signature');
  if (!signatureHex(header)) return new Response('not found', { status: 404 });

  const secret = await readSetting('github_sync_secret');
  // Unconfigured reads as nonexistent rather than forbidden, matching how
  // requireStaff hides the dashboard from people who cannot use it.
  if (!secret) return new Response('not found', { status: 404 });

  // The raw text, hashed exactly as it arrived. Re-serialising parsed JSON
  // would change bytes the sender signed.
  const raw = await ctx.request.text();
  if (!(await verifySignature(secret, raw, header))) {
    return new Response('bad signature', { status: 401 });
  }

  let payload: { issues?: IssueSnapshot[]; backfill?: boolean };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (!Array.isArray(payload.issues)) return new Response('no issues', { status: 400 });

  const result = await syncIssues(payload.issues, {
    origin: ctx.url.origin,
    backfill: payload.backfill === true,
  });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};
