import type { APIRoute } from 'astro';
import { buildSessionUser, exchangeCode } from '../../lib/auth';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const code = ctx.url.searchParams.get('code');
  const state = ctx.url.searchParams.get('state');
  const expected = await ctx.session?.get('oauth_state');
  const next = (await ctx.session?.get('oauth_next')) ?? '/';

  // CSRF: the state must round-trip through our own session.
  if (!code || !state || state !== expected) {
    return ctx.redirect('/?auth=failed', 302);
  }

  const redirectUri = new URL('/auth/callback', ctx.url.origin).toString();
  try {
    const { access_token } = await exchangeCode(code, redirectUri);
    const user = await buildSessionUser(access_token);
    await ctx.session?.set('user', user);
  } catch {
    return ctx.redirect('/?auth=failed', 302);
  } finally {
    // The access token is never stored: everything we need is resolved now.
    await ctx.session?.delete('oauth_state');
    await ctx.session?.delete('oauth_next');
  }

  return ctx.redirect(next, 302);
};
