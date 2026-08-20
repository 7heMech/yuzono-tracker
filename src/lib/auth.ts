import { env } from 'cloudflare:workers';
import type { APIContext, AstroGlobal } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { users, type StaffLevel, type User } from './db/schema';
import { combine, type Level } from './levels';
import { idList, readConfig } from './settings';

export interface SessionUser {
  id: string;
  username: string;
  avatarHash: string | null;
  accountCreatedAt: number;
  /**
   * Staff level as it stood at login, for deciding what to *show*. Never for
   * deciding what to allow: every privileged action re-reads the level from
   * D1 (see lib/staff.ts), so a revocation takes effect immediately instead of
   * waiting for the person to log in again.
   */
  level: Level;
  /**
   * The role ids this member holds in the guild, captured at login. Shown in
   * the dashboard because role *names* need a bot to resolve — this is the
   * only way to find an id from inside the app.
   */
  guildRoles: string[];
  /** Passed the guild-membership and account-age gate at login. */
  canWrite: boolean;
}

const DISCORD_API = 'https://discord.com/api/v10';
const SCOPES = ['identify', 'guilds', 'guilds.members.read'];

/** Discord snowflakes encode creation time — no extra scope, no API call. */
export function snowflakeCreatedAt(id: string): number {
  return Number((BigInt(id) >> 22n) + 1_420_070_400_000n) / 1000;
}

export const authorizeUrl = (state: string, redirectUri: string) =>
  `${DISCORD_API.replace('/api/v10', '')}/oauth2/authorize?` +
  new URLSearchParams({
    client_id: String(env.DISCORD_CLIENT_ID),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    prompt: 'none',
  });

export async function exchangeCode(code: string, redirectUri: string) {
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: String(env.DISCORD_CLIENT_ID),
      client_secret: String(env.DISCORD_CLIENT_SECRET),
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    // Discord explains itself in the body — usually a redirect_uri that does
    // not exactly match the one registered on the application.
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { access_token: string };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Builds the session user and decides whether they may write.
 *
 * Deliberately needs no permission on the Discord server: `guilds` lists the
 * guilds the user is in, and `guilds.members.read` returns their own member
 * object with role ids. No bot, no admin. Role *names* aren't resolvable
 * without a bot, hence MAINTAINER_ROLE_IDS holds ids.
 */
export async function buildSessionUser(token: string): Promise<SessionUser> {
  const me = (await (await fetch(`${DISCORD_API}/users/@me`, { headers: bearer(token) })).json()) as {
    id: string;
    username: string;
    avatar: string | null;
  };

  const cfg = await readConfig();
  const guildId = String(env.DISCORD_GUILD_ID);
  const minAgeDays = Number(cfg.min_account_age_days || 30);
  const accountCreatedAt = snowflakeCreatedAt(me.id);
  const ageDays = (Date.now() / 1000 - accountCreatedAt) / 86_400;

  const guilds = (await (
    await fetch(`${DISCORD_API}/users/@me/guilds`, { headers: bearer(token) })
  ).json()) as { id: string }[];
  const inGuild = Array.isArray(guilds) && guilds.some((g) => g.id === guildId);

  let discordLevel: StaffLevel | null = null;
  let roles: string[] = [];
  let joinedAt: number | null = null;
  if (inGuild) {
    const res = await fetch(`${DISCORD_API}/users/@me/guilds/${guildId}/member`, {
      headers: bearer(token),
    });
    if (res.ok) {
      const member = (await res.json()) as { roles: string[]; joined_at: string };
      roles = member.roles ?? [];
      const admins = idList(cfg.admin_role_ids);
      const mods = idList(cfg.mod_role_ids);
      if (roles.some((r) => admins.includes(r))) discordLevel = 'admin';
      else if (roles.some((r) => mods.includes(r))) discordLevel = 'mod';
      joinedAt = member.joined_at ? Math.floor(new Date(member.joined_at).getTime() / 1000) : null;
    }
  }

  // Upsert and read back in one statement: `manual_level` is granted in the
  // dashboard and must not be clobbered by a login, but it is needed here to
  // resolve the level this session displays.
  const [row] = await db()
    .insert(users)
    .values({
      discordId: me.id,
      username: me.username,
      avatarHash: me.avatar,
      accountCreatedAt: Math.floor(accountCreatedAt),
      guildJoinedAt: joinedAt,
      discordLevel,
    })
    .onConflictDoUpdate({
      target: users.discordId,
      set: {
        username: me.username,
        avatarHash: me.avatar,
        discordLevel,
        guildJoinedAt: joinedAt,
        lastLogin: sql`(unixepoch())`,
      },
    })
    .returning({ manualLevel: users.manualLevel });

  const owner = !!env.OWNER_DISCORD_ID && String(env.OWNER_DISCORD_ID).trim() === me.id;

  return {
    id: me.id,
    username: me.username,
    avatarHash: me.avatar,
    accountCreatedAt,
    level: owner ? 'owner' : combine(discordLevel, row?.manualLevel ?? null),
    guildRoles: roles,
    canWrite: inGuild && ageDays >= minAgeDays,
  };
}

export async function currentUser(
  ctx: APIContext | AstroGlobal,
): Promise<SessionUser | null> {
  return (await ctx.session?.get('user')) ?? null;
}

/** The avatar URL Discord serves for this user, or null for the default one. */
export const avatarUrl = (u: SessionUser, size = 32) =>
  u.avatarHash
    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatarHash}.png?size=${size}`
    : null;

/** Why a signed-in user still can't write — shown as a real explanation. */
export function writeBlockReason(u: SessionUser | null): string | null {
  if (!u) return 'sign-in';
  if (u.canWrite) return null;
  return 'gate';
}

export async function dbUser(discordId: string): Promise<User | undefined> {
  const [row] = await db().select().from(users).where(eq(users.discordId, discordId));
  return row;
}
