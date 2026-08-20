import type { APIRoute } from 'astro';
import { authorizeUrl } from '../../lib/auth';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const next = ctx.url.searchParams.get('next') ?? '/';
  const state = crypto.randomUUID();
  ctx.session?.set('oauth_state', state);
  ctx.session?.set('oauth_next', next);

  const redirectUri = new URL('/auth/callback', ctx.url.origin).toString();
  return ctx.redirect(authorizeUrl(state, redirectUri), 302);
};
