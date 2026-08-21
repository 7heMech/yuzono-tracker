import type { APIRoute } from 'astro';
import { canWriteNow, currentUser } from '../lib/auth';
import { toggleVote } from '../lib/vote';
import { announceDemand } from '../lib/webhook';
import { safeReturnTo } from '../lib/redirect';
import { isReportId, isVotableReport } from '../lib/writes';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const form = await ctx.request.formData();
  const reportId = Number(form.get('report'));
  const back = safeReturnTo(ctx.request.headers.get('referer'), ctx.url.origin);

  // `Number.isInteger(reportId)` alone let two bad values through: a missing
  // field became `Number(null)` — that is 0, an integer — and any large made-up
  // id passed as well. Both then reached the database as a foreign key.
  if (!isReportId(reportId)) return ctx.redirect(back, 303);

  // Checked before the sign-in detour, not after it. An anonymous vote is
  // remembered in the session and replayed by /auth/callback, so an id that
  // cannot be voted on is a session value that makes the *next* sign-in throw
  // — and it kept doing so for every sign-in after that. Refusing it here
  // means nothing unusable is ever stored.
  if (!(await isVotableReport(reportId))) return ctx.redirect(back, 303);

  const user = await currentUser(ctx);
  if (!user) {
    // Remember the intent so signing in completes the click instead of
    // silently discarding it.
    ctx.session?.set('pending_vote', reportId);
    return ctx.redirect(`/auth/discord?next=${encodeURIComponent(back)}`, 302);
  }
  // Re-derived rather than read off the session: `user.canWrite` was decided at
  // login and never revisited, so a banned account kept voting until it chose
  // to sign in again.
  if (!(await canWriteNow(user))) return ctx.redirect('/cant-post', 302);

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
