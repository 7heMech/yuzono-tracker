import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { settings } from './db/schema';

/**
 * Runtime configuration.
 *
 * Every key has an environment-backed default, so a fresh database is already
 * a working install and the dashboard is an override rather than a
 * prerequisite. Reads hit D1 on demand: these are looked up on login, on a
 * status change and on the dashboard itself — never in the anonymous read path
 * the board is optimised for.
 */

export const SETTING_KEYS = [
  'mod_role_ids',
  'admin_role_ids',
  'min_account_age_days',
  'webhook_url',
  'webhook_on_fixed',
  'webhook_vote_threshold',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const DEFAULTS: Record<SettingKey, () => string> = {
  // Seeded from the environment where a var exists, so nothing is lost by
  // moving configuration into the database. DISCORD_WEBHOOK_URL is honoured if
  // someone sets it by hand, but it is not asked for at deploy time — /admin
  // owns that setting and can test it, which a deploy prompt cannot.
  mod_role_ids: () => String(env.MAINTAINER_ROLE_IDS ?? ''),
  admin_role_ids: () => '',
  min_account_age_days: () => String(env.MIN_ACCOUNT_AGE_DAYS ?? 30),
  webhook_url: () => String(env.DISCORD_WEBHOOK_URL ?? ''),
  webhook_on_fixed: () => '1',
  webhook_vote_threshold: () => '0',
};

export type Config = Record<SettingKey, string>;

export async function readConfig(): Promise<Config> {
  const rows = await db().select().from(settings);
  const stored = new Map(rows.map((r) => [r.key, r.value ?? '']));
  const out = {} as Config;
  for (const key of SETTING_KEYS) {
    const v = stored.get(key);
    out[key] = v === undefined ? DEFAULTS[key]() : v;
  }
  return out;
}

export async function writeSettings(
  values: Partial<Record<SettingKey, string>>,
  actorId: string,
) {
  const d = db();
  // Written one at a time rather than batched: unlike the vote counter, these
  // keys are independent, so there is no pair that must land together.
  for (const [key, value] of Object.entries(values) as [SettingKey, string][]) {
    await d
      .insert(settings)
      .values({ key, value, updatedBy: actorId })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedBy: actorId, updatedAt: sql`(unixepoch())` },
      });
  }
}

export async function readSetting(key: SettingKey): Promise<string> {
  const [row] = await db().select().from(settings).where(eq(settings.key, key));
  return row?.value ?? DEFAULTS[key]();
}

/** Comma-separated ids, tolerant of spaces and stray newlines when pasted. */
export const idList = (raw: string): string[] =>
  raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,}$/.test(s));
