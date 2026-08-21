import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from './db/client';
import { reports, type Report } from './db/schema';
import { readConfig, type Config } from './settings';
import { getSource } from './sources';
import { reportHeadline } from './format';
import { reporterMeta } from './reporter';

/**
 * Outbound Discord announcements.
 *
 * A channel webhook needs only Manage Webhooks on one channel, so a maintainer
 * can hand over a URL without a bot and without giving this board any standing
 * permission in the guild. That is the whole reason announcements work this
 * way instead of through a bot token.
 */

const GREEN = 0x3ba55d;
const YELLOW = 0xf5c542;

export interface Embed {
  title: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}

export async function send(webhookUrl: string, embed: Embed) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: [{ color: YELLOW, ...embed }], allowed_mentions: { parse: [] } }),
  });
  return { ok: res.ok, status: res.status, body: res.ok ? '' : await res.text() };
}

const subject = (r: Pick<Report, 'sourceId' | 'proposedName'>) =>
  getSource(r.sourceId)?.name ?? r.proposedName ?? 'a source';

/**
 * Announce a fix. Fires once per report; `fix_announced_at` is the guard.
 *
 * That column exists purely so this is not the same guard as the demand
 * alert's. Sharing `announced_at` meant a demand alert permanently consumed
 * the fix announcement — and it did so for exactly the reports whose fix was
 * most worth announcing, since crossing the demand threshold is what fired the
 * alert in the first place.
 */
export async function announceFixed(report: Report, origin: string, cfg?: Config) {
  const c = cfg ?? (await readConfig());
  if (!c.webhook_url || c.webhook_on_fixed !== '1') return null;

  // Claim the announcement before sending, so two near-simultaneous status
  // changes cannot both post.
  const claimed = await db()
    .update(reports)
    .set({ fixAnnouncedAt: sql`(unixepoch())` })
    .where(and(eq(reports.id, report.id), isNull(reports.fixAnnouncedAt)))
    .returning({ id: reports.id });
  if (!claimed.length) return null;

  return send(c.webhook_url, {
    title: `Fixed: ${subject(report)}`,
    description: report.title,
    url: `${origin}/report/${report.id}`,
    color: GREEN,
    fields: [{ name: 'Reported by', value: `${report.votes} people`, inline: true }],
  });
}

/**
 * Announce a report that has crossed the demand threshold. `announced_at` is
 * this alert's own guard, so it fires once and — unlike before — does not also
 * spend the fix announcement. The two are genuinely different news.
 */
export async function announceDemand(reportId: number, origin: string) {
  const cfg = await readConfig();
  const threshold = Number(cfg.webhook_vote_threshold || 0);
  if (!cfg.webhook_url || threshold <= 0) return null;

  const [report] = await db().select().from(reports).where(eq(reports.id, reportId));
  if (!report || report.announcedAt || report.votes < threshold) return null;

  const claimed = await db()
    .update(reports)
    .set({ announcedAt: sql`(unixepoch())` })
    .where(and(eq(reports.id, reportId), isNull(reports.announcedAt)))
    .returning({ id: reports.id });
  if (!claimed.length) return null;

  const title =
    report.kind === 'request'
      ? `${report.votes} people want ${subject(report)}`
      : `${report.votes} people are hit by ${subject(report)}`;

  return send(cfg.webhook_url, {
    title,
    description: report.title,
    url: `${origin}/report/${report.id}`,
  });
}

/**
 * Announce a newly filed report.
 *
 * Filing needs no claim column: it happens once by construction because the
 * partial unique index turns a second attempt into an upvote and a ?joined=1
 * redirect. Only genuine inserts reach this call site; the joined path is
 * silent by design.
 *
 * One function, not two, that picks its own gate from `report.kind`. Takes a
 * narrow `Pick<Report, ...>` so callers need not widen `returning()` further
 * than necessary, and reuses `subject()` and `reportHeadline()` so the embed
 * says what the board says.
 */
export async function announceFiled(
  report: Pick<Report, 'id' | 'kind' | 'title' | 'stage' | 'cause' | 'sourceId' | 'proposedName' | 'reporterId'>,
  origin: string,
  cfg?: Config,
) {
  const c = cfg ?? (await readConfig());
  if (!c.webhook_url) return null;
  const gate = report.kind === 'request' ? c.webhook_on_new_request : c.webhook_on_new_report;
  if (gate !== '1') return null;

  const headline = reportHeadline(report);
  const who = reporterMeta(report.reporterId).mention;

  return send(c.webhook_url, {
    title: headline,
    description: `on ${subject(report)}`,
    url: `${origin}/report/${report.id}`,
    fields: [{ name: 'Filed by', value: who, inline: true }],
  });
}

export async function testWebhook(webhookUrl: string, origin: string, actor: string) {
  return send(webhookUrl, {
    title: 'Webhook connected',
    description:
      `Sent from the tracker dashboard by ${actor}. Fix announcements and ` +
      `demand alerts will arrive in this channel.`,
    url: origin,
  });
}
