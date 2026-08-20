import type { APIRoute } from 'astro';
import { currentUser } from '../lib/auth';
import { toggleVote } from '../lib/vote';
import { announceDemand } from '../lib/webhook';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const form = await ctx.request.formData();
  const reportId = Number(form.get('report'));
  const back = ctx.request.headers.get('referer') ?? '/';
  if (!Number.isInteger(reportId)) return ctx.redirect(back, 303);

  const user = await currentUser(ctx);
  if (!user) {
    // Remember the intent so signing in completes the click instead of
    // silently discarding it.
    ctx.session?.set('pending_vote', reportId);
    return ctx.redirect(`/auth/discord?next=${encodeURIComponent(back)}`, 302);
  }
  if (!user.canWrite) return ctx.redirect('/cant-post', 302);

  const result = await toggleVote(reportId, user.id);
  if (result === 'added') {
    // Crossing the demand threshold is worth a Discord post, but not worth
    // making the voter wait for Discord to answer.
    const announce = announceDemand(reportId, ctx.url.origin);
    const cf = ctx.locals.cfContext;
    if (cf) cf.waitUntil(announce);
    else await announce;
  }
  return ctx.redirect(back, 303);
};
