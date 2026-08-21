import { env } from 'cloudflare:workers';
import type { APIContext, AstroGlobal } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { audit, users, type StaffLevel } from './db/schema';
import { atLeast, combine as combineLevels, type Level } from './levels';
import { currentUser, type SessionUser } from './auth';

export { atLeast, combine, LEVEL_LABELS, type Level } from './levels';

/**
 * Who may do what.
 *
 * The session carries a level for *display* only. Every privileged action
 * re-reads it from D1, because a session is a snapshot: without the re-read, a
 * grant would not apply until the person logged in again, and — much worse — a
 * revocation would not apply until they chose to.
 */

export const isOwner = (discordId: string) =>
  !!env.OWNER_DISCORD_ID && String(env.OWNER_DISCORD_ID).trim() === discordId;

/** Authoritative level, read fresh. Owner outranks whatever the table says. */
export async function levelOf(discordId: string): Promise<Level> {
  if (isOwner(discordId)) return 'owner';
  const [row] = await db()
    .select({ discordLevel: users.discordLevel, manualLevel: users.manualLevel })
    .from(users)
    .where(eq(users.discordId, discordId));
  if (!row) return 'user';
  return combineLevels(row.discordLevel, row.manualLevel);
}

export interface StaffContext {
  user: SessionUser;
  level: Level;
}

/**
 * Gate for a page or route. Returns the caller when they clear `needed`, or a
 * Response to return as-is — 404 rather than 403 for a non-staff visitor,
 * since the existence of the dashboard is not their business.
 */
export async function requireStaff(
  ctx: APIContext | AstroGlobal,
  needed: Level = 'mod',
): Promise<StaffContext | Response> {
  const user = await currentUser(ctx);
  if (!user) {
    const to = new URL(ctx.request.url).pathname;
    return ctx.redirect(`/auth/discord?next=${encodeURIComponent(to)}`, 302);
  }
  const level = await levelOf(user.id);
  if (!atLeast(level, needed)) return new Response('Not found', { status: 404 });
  return { user, level };
}

export const isResponse = (v: unknown): v is Response => v instanceof Response;

/**
 * `Pick` rather than `SessionUser`, because the GitHub sync writes audit rows
 * and has no session to speak of — it passes a synthetic actor instead (see
 * SYNC_ACTOR in lib/github-sync.ts). Only these two fields were ever read.
 */
export async function logAction(
  actor: Pick<SessionUser, 'id' | 'username'>,
  action: string,
  target?: string | null,
  detail?: string | null,
) {
  await db()
    .insert(audit)
    .values({
      actorId: actor.id,
      actorName: actor.username,
      action,
      target: target ?? null,
      detail: detail ?? null,
    });
}

/** Grant or clear a manual level. Clearing passes null. */
export async function setManualLevel(discordId: string, level: StaffLevel | null) {
  await db()
    .update(users)
    .set({ manualLevel: level, lastLogin: sql`${users.lastLogin}` })
    .where(eq(users.discordId, discordId));
}
