import { describe, expect, mock, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../../src/lib/db/schema';
import { schemaDb } from '../helpers/schema-db';

const sqlite = await schemaDb();
const d = drizzle(sqlite, { schema });

mock.module('cloudflare:workers', () => ({
  env: {},
}));

mock.module('../../src/lib/db/client', () => ({
  db: () => d,
  schema,
}));

const { announceStatusChanged, announceFiled } = await import('../../src/lib/webhook');
import type { Config } from '../../src/lib/settings';
import type { Report } from '../../src/lib/db/schema';

describe('webhook announcements toggles', () => {
  const dummyReport: Report = {
    id: 101,
    kind: 'bug',
    sourceId: null,
    proposedName: 'Test Source',
    proposedUrl: null,
    lang: 'en',
    nsfw: false,
    stage: 'video',
    cause: 'extractor',
    problem: 'no-video',
    title: 'Video fails',
    body: null,
    status: 'confirmed',
    statusNote: null,
    statusChangedAt: 1000,
    reporterId: '12345',
    githubIssue: null,
    votes: 5,
    announcedAt: null,
    fixAnnouncedAt: null,
    promotedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    newUrl: null,
    extVersion: null,
    appName: null,
    appVersion: null,
    duplicateOf: null,
  };

  const baseConfig: Config = {
    mod_role_ids: '',
    admin_role_ids: '',
    min_account_age_days: '30',
    webhook_url: 'https://discord.com/api/webhooks/test',
    webhook_on_fixed: '1',
    webhook_on_status_changed: '0',
    webhook_on_new_report: '1',
    webhook_on_new_request: '1',
    webhook_include_actor: '0',
    webhook_vote_threshold: '0',
    github_sync_secret: '',
    github_webhook_secret: '',
  };

  test('announceStatusChanged returns null when status is not fixed and webhook_on_status_changed is 0', async () => {
    const res = await announceStatusChanged(dummyReport, 'http://localhost', baseConfig, 'Alice');
    expect(res).toBeNull();
  });

  test('announceStatusChanged triggers when webhook_on_status_changed is 1 even if non-fixed', async () => {
    const originalFetch = global.fetch;
    let postedBody: any = null;
    global.fetch = (async (_url: string, init?: any) => {
      postedBody = JSON.parse(init.body);
      return new Response('', { status: 200 });
    }) as typeof fetch;

    try {
      const cfg: Config = { ...baseConfig, webhook_on_status_changed: '1', webhook_include_actor: '1' };
      const res = await announceStatusChanged(dummyReport, 'http://localhost', cfg, 'Alice');
      expect(res).not.toBeNull();
      expect(res?.ok).toBe(true);
      expect(postedBody).not.toBeNull();
      const embed = postedBody.embeds[0];
      expect(embed.title).toContain('Status updated (Confirmed)');
      expect(embed.fields).toContainEqual({ name: 'Action by', value: 'Alice', inline: true });
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('announceFiled includes Action by when webhook_include_actor is 1', async () => {
    const originalFetch = global.fetch;
    let postedBody: any = null;
    global.fetch = (async (_url: string, init?: any) => {
      postedBody = JSON.parse(init.body);
      return new Response('', { status: 200 });
    }) as typeof fetch;

    try {
      const cfg: Config = { ...baseConfig, webhook_include_actor: '1' };
      const res = await announceFiled(dummyReport, 'http://localhost', cfg);
      expect(res).not.toBeNull();
      const embed = postedBody.embeds[0];
      expect(embed.fields).toContainEqual({ name: 'Action by', value: 'unknown', inline: true });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
