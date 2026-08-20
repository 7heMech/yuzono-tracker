import type { APIRoute } from 'astro';
import { buildSessionUser, exchangeCode } from '../../lib/auth';
import { safeReturnTo } from '../../lib/redirect';
import { ensureVote } from '../../lib/vote';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const code = ctx.url.searchParams.get('code');
  const state = ctx.url.searchParams.get('state');
  const expected = await ctx.session?.get('oauth_state');
  // Re-checked on the way out as well: the session is ours, but a value that
  // only gets validated on the way in is one refactor away from not being.
  const next = safeReturnTo(await ctx.session?.get('oauth_next'), ctx.url.origin);

  // CSRF: the state must round-trip through our own session.
  if (!code || !state || state !== expected) {
    return ctx.redirect('/?auth=failed', 302);
  }

  const redirectUri = new URL('/auth/callback', ctx.url.origin).toString();
  try {
    const { access_token } = await exchangeCode(code, redirectUri);
    const user = await buildSessionUser(access_token);
    ctx.session?.set('user', user);

    // Finish whatever the user was trying to do before they were interrupted.
    const pendingVote = await ctx.session?.get('pending_vote');
    if (pendingVote && user.canWrite) {
      await ensureVote(Number(pendingVote), user.id);
    }
    ctx.session?.delete('pending_vote');
  } catch (err) {
    // `?auth=failed` is all the visitor needs, but swallowing the cause makes
    // first-time OAuth setup undebuggable.
    console.error('[auth] callback failed:', err);
    return ctx.redirect('/?auth=failed', 302);
  } finally {
    // The access token is never stored: everything we need is resolved now.
    ctx.session?.delete('oauth_state');
    ctx.session?.delete('oauth_next');
  }

  return ctx.redirect(next, 302);
};
