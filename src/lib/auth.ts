import { env } from 'cloudflare:workers';
import type { APIContext, AstroGlobal } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { users, type StaffLevel, type User } from './db/schema';
import { combine, type Level } from './levels';
import { idList, readConfig, readSetting } from './settings';

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
  /**
   * Was in the guild at login.
   *
   * Kept separately from `canWrite` because it is the one half of the gate
   * that cannot be re-derived later: reading it needs a Discord token and this
   * app deliberately stores none. Everything else `canWriteNow` re-checks.
   */
  inGuild: boolean;
  /**
   * Passed the whole write gate at login, for deciding what to *show* — a
   * "report this" button, a vote control. Never for deciding what to allow:
   * use `canWriteNow`, which re-reads the ban flag and the age threshold, in
   * the same way lib/staff.ts re-reads the staff level.
   */
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
 *
 * The `canWrite` it returns is a snapshot for the UI. What is actually allowed
 * is decided per write by `canWriteNow` below.
 */
export async function buildSessionUser(token: string): Promise<SessionUser> {
  // The identity call, the guild list and the settings read are mutually
  // independent, so they go out together. Awaiting them one after another cost
  // three serial round-trips on every sign-in for no reason. The member
  // endpoint below genuinely cannot join them: its URL contains the guild id,
  // which is only worth asking for once the guild list says we are in it.
  const [meRes, guildsRes, cfg] = await Promise.all([
    fetch(`${DISCORD_API}/users/@me`, { headers: bearer(token) }),
    fetch(`${DISCORD_API}/users/@me/guilds`, { headers: bearer(token) }),
    readConfig(),
  ]);

  if (!meRes.ok) {
    // Without this the failure surfaces as a BigInt parse error on an
    // undefined id, which says nothing about what actually went wrong.
    throw new Error(`discord /users/@me failed: ${meRes.status} ${await meRes.text()}`);
  }
  const me = (await meRes.json()) as {
    id: string;
    username: string;
    avatar: string | null;
  };

  const guildId = String(env.DISCORD_GUILD_ID);
  const minAgeDays = Number(cfg.min_account_age_days || 30);
  const accountCreatedAt = snowflakeCreatedAt(me.id);
  const ageDays = (Date.now() / 1000 - accountCreatedAt) / 86_400;

  let inGuild = false;
  let membershipKnown = false;
  if (guildsRes.ok) {
    const guilds = (await guildsRes.json()) as { id: string }[];
    if (Array.isArray(guilds)) {
      membershipKnown = true;
      inGuild = guilds.some((g) => g.id === guildId);
    }
  }

  let discordLevel: StaffLevel | null = null;
  let roles: string[] = [];
  let joinedAt: number | null = null;
  /**
   * Did this login actually *learn* the member's roles? A 429 or a blip on the
   * member endpoint must not be read as "holds no roles": the upsert below
   * would then write discord_level: null and the demotion would stand until
   * that person happened to sign in again successfully. When this is false the
   * role-derived columns are left out of the statement entirely, which is not
   * the same as writing the old value back — it means the stored value stands.
   */
  let rolesResolved = false;
  if (inGuild) {
    const res = await fetch(`${DISCORD_API}/users/@me/guilds/${guildId}/member`, {
      headers: bearer(token),
    });
    if (res.ok) {
      rolesResolved = true;
      const member = (await res.json()) as { roles: string[]; joined_at: string };
      roles = member.roles ?? [];
      const admins = idList(cfg.admin_role_ids);
      const mods = idList(cfg.mod_role_ids);
      if (roles.some((r) => admins.includes(r))) discordLevel = 'admin';
      else if (roles.some((r) => mods.includes(r))) discordLevel = 'mod';
      joinedAt = member.joined_at ? Math.floor(new Date(member.joined_at).getTime() / 1000) : null;
    }
  } else if (membershipKnown) {
    // The guild list answered and we are not in it: there are no roles to
    // hold, which is a real answer rather than a missing one. This is the path
    // that takes staff away from someone who left the server.
    rolesResolved = true;
  }

  /** Written only on the two paths above that know the answer. */
  const roleColumns = rolesResolved ? { discordLevel, guildJoinedAt: joinedAt } : {};

  // Upsert and read back in one statement: `manual_level` is granted in the
  // dashboard and must not be clobbered by a login, but it is needed here to
  // resolve the level this session displays. `banned` comes back from the same
  // statement so a banned account does not even get a session that claims it
  // may write.
  const [row] = await db()
    .insert(users)
    .values({
      discordId: me.id,
      username: me.username,
      avatarHash: me.avatar,
      accountCreatedAt: Math.floor(accountCreatedAt),
      ...roleColumns,
    })
    .onConflictDoUpdate({
      target: users.discordId,
      set: {
        username: me.username,
        avatarHash: me.avatar,
        lastLogin: sql`(unixepoch())`,
        ...roleColumns,
      },
    })
    .returning({
      discordLevel: users.discordLevel,
      manualLevel: users.manualLevel,
      banned: users.banned,
    });

  const owner = !!env.OWNER_DISCORD_ID && String(env.OWNER_DISCORD_ID).trim() === me.id;

  return {
    id: me.id,
    username: me.username,
    avatarHash: me.avatar,
    accountCreatedAt,
    // Read back rather than reused from `discordLevel`: on the path where the
    // member fetch failed the local variable is null but the column still
    // holds the level from last time, and the statement returns that — so a
    // Discord blip no longer demotes the UI either, not just the row.
    level: owner ? 'owner' : combine(row?.discordLevel ?? null, row?.manualLevel ?? null),
    guildRoles: roles,
    inGuild,
    canWrite: inGuild && !row?.banned && ageDays >= minAgeDays,
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

/**
 * Why this visitor may not write, or null if they may.
 *
 * `sign-in` — nobody is signed in.
 * `guild`   — not in the Discord as of their last sign-in.
 * `banned`  — blocked by hand in the dashboard.
 * `age`     — account younger than the current threshold.
 */
export type WriteBlock = 'sign-in' | 'guild' | 'banned' | 'age';

/**
 * The single place that decides whether a write is allowed, and says why not.
 *
 * The session is a snapshot, so trusting `canWrite` meant the gate could never
 * be tightened or revoked: someone kicked from the Discord kept filing and
 * voting, and raising the age threshold in /admin left everyone already signed
 * in on the old one. Two of the three conditions are therefore re-read here on
 * every write, exactly as lib/staff.ts re-reads the staff level.
 *
 * Guild membership is the exception, and unavoidably so: it can only be read
 * with a Discord access token, and this app throws the token away at the end
 * of the OAuth callback rather than storing one. That is a deliberate trade —
 * no stored credential to leak — and it is why astro.config.mjs gives sessions
 * a TTL: a week of staleness is a bounded risk, an unbounded one is not.
 *
 * A session created before `inGuild` existed does not carry it and so fails
 * closed here; one sign-in fixes it.
 */
export async function writeBlockReason(u: SessionUser | null): Promise<WriteBlock | null> {
  if (!u) return 'sign-in';
  if (!u.inGuild) return 'guild';

  const [row] = await db()
    .select({ banned: users.banned })
    .from(users)
    .where(eq(users.discordId, u.id));
  // A missing row means the login upsert never landed, which should not happen
  // and is not something to hand write access to on a guess.
  if (!row || row.banned) return 'banned';

  // readSetting rather than readConfig: one indexed lookup by key instead of
  // reading the whole settings table for the single value that matters here.
  const minAgeDays = Number((await readSetting('min_account_age_days')) || 30);
  const ageDays = (Date.now() / 1000 - u.accountCreatedAt) / 86_400;
  return ageDays < minAgeDays ? 'age' : null;
}

/**
 * May this user write *right now*? Call this on every write path — filing,
 * requesting, voting — instead of reading `canWrite` off the session.
 */
export async function canWriteNow(user: SessionUser): Promise<boolean> {
  return (await writeBlockReason(user)) === null;
}

export async function dbUser(discordId: string): Promise<User | undefined> {
  const [row] = await db().select().from(users).where(eq(users.discordId, discordId));
  return row;
}
