import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { authorizeUrl } from '../../lib/auth';
import { safeReturnTo } from '../../lib/redirect';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  // Without this, an unconfigured app sends people to Discord with an empty
  // client_id and they get Discord's own opaque error page instead of ours.
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return new Response(
      'Discord sign-in is not configured. Copy .dev.vars.example to .dev.vars, ' +
        'fill in DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET, and restart the dev server.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const next = safeReturnTo(ctx.url.searchParams.get('next'), ctx.url.origin);
  const state = crypto.randomUUID();
  ctx.session?.set('oauth_state', state);
  ctx.session?.set('oauth_next', next);

  const redirectUri = new URL('/auth/callback', ctx.url.origin).toString();
  return ctx.redirect(authorizeUrl(state, redirectUri), 302);
};
