import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { authorizeUrl } from '../../lib/auth';
import { safeReturnTo } from '../../lib/redirect';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  // Without this, an unconfigured app sends people to Discord with an empty
  // client_id and they get Discord's own opaque error page instead of ours.
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    const missing = [
      !env.DISCORD_CLIENT_ID && 'DISCORD_CLIENT_ID',
      !env.DISCORD_CLIENT_SECRET && 'DISCORD_CLIENT_SECRET',
    ]
      .filter(Boolean)
      .join(' and ');
    // These two cannot come from /admin — they are what makes signing in
    // possible, so the dashboard they would configure is unreachable without
    // them. Which is also why this message has to say where they *do* live,
    // and say it differently depending on where it is being read.
    const how = import.meta.env.DEV
      ? 'Copy .dev.vars.example to .dev.vars, fill it in, and restart the dev server.'
      : 'Add it as a secret: Cloudflare dashboard → your Worker → Settings → ' +
        'Variables and Secrets → Add, or `wrangler secret put <NAME>`. ' +
        'A secret survives deploys; a plain variable this repo does not declare ' +
        'is deleted by the next one.';
    return new Response(`Discord sign-in is not configured: ${missing} is missing.\n\n${how}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const next = safeReturnTo(ctx.url.searchParams.get('next'), ctx.url.origin);
  const state = crypto.randomUUID();
  ctx.session?.set('oauth_state', state);
  ctx.session?.set('oauth_next', next);

  const redirectUri = new URL('/auth/callback', ctx.url.origin).toString();
  return ctx.redirect(authorizeUrl(state, redirectUri), 302);
};
