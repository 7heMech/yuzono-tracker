import type { APIRoute } from 'astro';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../lib/db/client';
import { reports, votes } from '../lib/db/schema';
import { currentUser } from '../lib/auth';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const form = await ctx.request.formData();
  const reportId = Number(form.get('report'));
  const back = ctx.request.headers.get('referer') ?? '/';
  if (!Number.isInteger(reportId)) return ctx.redirect(back, 303);

  const user = await currentUser(ctx);
  // Never dead-end the obvious action: send them to sign in and come back.
  if (!user) return ctx.redirect(`/auth/discord?next=${encodeURIComponent(back)}`, 302);
  if (!user.canWrite) return ctx.redirect('/cant-post', 302);

  const d = db();
  const existing = await d
    .select({ reportId: votes.reportId })
    .from(votes)
    .where(and(eq(votes.reportId, reportId), eq(votes.discordId, user.id)));

  // The counter and the vote row move together in one D1 batch, so the ranking
  // column can never drift from the truth.
  if (existing.length) {
    await d.batch([
      d.delete(votes).where(and(eq(votes.reportId, reportId), eq(votes.discordId, user.id))),
      d
        .update(reports)
        .set({ votes: sql`max(0, ${reports.votes} - 1)` })
        .where(eq(reports.id, reportId)),
    ]);
  } else {
    await d.batch([
      d.insert(votes).values({ reportId, discordId: user.id }).onConflictDoNothing(),
      d
        .update(reports)
        .set({ votes: sql`${reports.votes} + 1` })
        .where(eq(reports.id, reportId)),
    ]);
  }

  return ctx.redirect(back, 303);
};
