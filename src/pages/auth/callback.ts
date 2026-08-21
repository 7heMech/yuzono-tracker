import type { APIRoute } from 'astro';
import { buildSessionUser, canWriteNow, exchangeCode } from '../../lib/auth';
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

    // Session fixation. Up to this line the session id is whatever the browser
    // sent, and the cookie is host-wide only by convention — anything running
    // on a sibling *.7he.dev host could set an id of its choosing, wait for
    // the victim to sign in here, and then replay that id as them, up to and
    // including the owner. Minting a fresh id at the moment the session
    // becomes authenticated means the id holding an authenticated session is
    // never one an attacker chose. regenerate() carries the existing data
    // across (so `pending_vote` below still resolves) and deletes the old KV
    // entry, and the `__Host-` cookie name in astro.config.mjs closes the
    // other half by stopping a sibling host from setting the cookie at all.
    await ctx.session?.regenerate();
    ctx.session?.set('user', user);

    /* A readable marker so the header can skip its user island entirely for the
       anonymous majority. The island is `server:defer`, so on all 310
       prerendered pages it cost one extra Worker invocation and 722 bytes to
       render markup byte-identical to the fallback already in the page.

       Deliberately not HttpOnly and deliberately not trusted: it carries no
       secret, and nothing decides anything from it. A forged one only makes the
       header render an island that then finds no session and shows the
       signed-out state. The session cookie remains the only authority. */
    ctx.cookies.set('signed_in', '1', {
      path: '/',
      httpOnly: false,
      secure: ctx.url.protocol === 'https:',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
    });

    // Finish whatever the user was trying to do before they were interrupted.
    // canWriteNow rather than user.canWrite: the same authority decides here
    // as on /vote, so a banned account cannot slip a vote through the one
    // write path that runs before any page gate does.
    const pendingVote = await ctx.session?.get('pending_vote');
    if (pendingVote && (await canWriteNow(user))) {
      await ensureVote(Number(pendingVote), user.id);
    }
  } catch (err) {
    // `?auth=failed` is all the visitor needs, but swallowing the cause makes
    // first-time OAuth setup undebuggable.
    console.error('[auth] callback failed:', err);
    return ctx.redirect('/?auth=failed', 302);
  } finally {
    // The access token is never stored: everything we need is resolved now.
    ctx.session?.delete('oauth_state');
    ctx.session?.delete('oauth_next');
    // `pending_vote` is cleared here and not in the try, because the whole
    // point is to clear it on the path that threw. ensureVote throws on a
    // report id that does not exist, and an anonymous visitor could plant one
    // by posting to /vote — after which the poison stayed in the session and
    // every *later* sign-in, however valid, landed on ?auth=failed. One
    // attempt is all a pending vote ever gets.
    ctx.session?.delete('pending_vote');
  }

  return ctx.redirect(next, 302);
};
