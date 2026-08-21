import { describe, expect, test } from 'bun:test';
import {
  classifyIssue,
  closedStatusFor,
  isMismatch,
  matchSourceHow,
  promoteTitle,
  promoteUrl,
  reportIdFromBody,
  sign,
  signatureHex,
  transitionFor,
  verifySignature,
  type IssueSnapshot,
} from '../../src/lib/github';

/**
 * No `mock.module('cloudflare:workers')` here, unlike tests/lib/writes.test.ts.
 * src/lib/github.ts is deliberately kept clear of any import that reaches that
 * module so these can run against the real thing; the D1 half lives in
 * github-sync.ts. If this file ever needs the stub, something has leaked.
 */

const issue = (over: Partial<IssueSnapshot> = {}): IssueSnapshot => ({
  number: 412,
  title: 'AniDB [EN]: Error 404 (Search)',
  state: 'open',
  stateReason: null,
  body: null,
  labels: [],
  createdAt: 1700000000,
  updatedAt: 1700000000,
  reactions: 0,
  ...over,
});

describe('verifySignature', () => {
  // GitHub's own documented example, so this pins our framing to theirs rather
  // than to whatever we happen to produce.
  const secret = "It's a Secret to Everybody";
  const body = 'Hello, World!';
  const good = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

  test('accepts the documented GitHub sample', async () => {
    expect(await verifySignature(secret, body, good)).toBe(true);
  });

  test('sign round-trips with verify', async () => {
    expect(await sign(secret, body)).toBe(good);
  });

  test('rejects a tampered body', async () => {
    expect(await verifySignature(secret, 'Hello, World?', good)).toBe(false);
  });

  test('rejects the wrong secret', async () => {
    expect(await verifySignature('not the secret', body, good)).toBe(false);
  });

  test('rejects a missing, empty or malformed header', async () => {
    expect(await verifySignature(secret, body, null)).toBe(false);
    expect(await verifySignature(secret, body, '')).toBe(false);
    expect(await verifySignature(secret, body, 'sha256=abc')).toBe(false);
    expect(await verifySignature(secret, body, good.slice(0, -1))).toBe(false);
    expect(await verifySignature(secret, body, good.replace('sha256', 'sha1'))).toBe(false);
  });

  test('rejects an unset secret even with a valid-looking header', async () => {
    expect(await verifySignature('', body, good)).toBe(false);
  });

  test('signatureHex screens junk before any database read', () => {
    expect(signatureHex(good)).toHaveLength(64);
    expect(signatureHex('SHA256=' + 'A'.repeat(64))).toHaveLength(64);
    expect(signatureHex('sha256=zz')).toBeNull();
    expect(signatureHex('garbage')).toBeNull();
    expect(signatureHex(null)).toBeNull();
  });
});

describe('closedStatusFor', () => {
  test('maps GitHub state_reason onto our statuses', () => {
    expect(closedStatusFor('completed')).toBe('fixed');
    expect(closedStatusFor('not_planned')).toBe('wont_fix');
    expect(closedStatusFor('duplicate')).toBe('duplicate');
  });

  test('treats no reason, and anything unrecognised, as a fix', () => {
    expect(closedStatusFor(null)).toBe('fixed');
    expect(closedStatusFor('reopened')).toBe('fixed');
  });
});

/**
 * The most valuable block in this file. These are the cases that stop the
 * scheduled pass from quietly reverting moderator decisions — a failure that is
 * invisible in one run and only shows up weeks later as staff wondering why
 * their work keeps coming undone.
 */
describe('transitionFor', () => {
  test('a closure applies', () => {
    expect(transitionFor('open', 'closed', 'completed')).toBe('fixed');
    expect(transitionFor('open', 'closed', 'not_planned')).toBe('wont_fix');
  });

  test('a closure on first sight applies too', () => {
    expect(transitionFor(null, 'closed', 'completed')).toBe('fixed');
  });

  test('a reopen applies', () => {
    // `confirmed`, not `open`: someone reopening it is evidence it is real.
    expect(transitionFor('closed', 'open', 'reopened')).toBe('confirmed');
  });

  test('a reopen is never inferred on first sight', () => {
    // No prior observation means no evidence of a transition. Guessing here
    // would resurrect every report a moderator had closed.
    expect(transitionFor(null, 'open', null)).toBeNull();
  });

  test('an issue that simply stays open does nothing', () => {
    // The load-bearing case. With no write access upstream, "we say fixed, they
    // say open" is the resting state after every moderator fix — so this must
    // never be read as an instruction to reopen.
    expect(transitionFor('open', 'open', null)).toBeNull();
  });

  test('an issue that stays closed does nothing', () => {
    expect(transitionFor('closed', 'closed', 'completed')).toBeNull();
  });
});

describe('isMismatch', () => {
  test('flags work that still needs closing upstream', () => {
    expect(isMismatch('fixed', 'open')).toBe(true);
    expect(isMismatch('wont_fix', 'open')).toBe(true);
    expect(isMismatch('duplicate', 'open')).toBe(true);
  });

  test('is quiet when the two agree', () => {
    expect(isMismatch('fixed', 'closed')).toBe(false);
    expect(isMismatch('open', 'open')).toBe(false);
    expect(isMismatch('in_progress', 'open')).toBe(false);
  });
});

describe('matchSourceHow', () => {
  test('an exact catalogue name is exact', () => {
    expect(matchSourceHow('AniDB [EN]: Error 404 (Search)')).toEqual({
      sourceId: '3556703948634317295',
      how: 'exact',
    });
  });

  test('a suffixed name is only a prefix match', () => {
    // "Anime1.me" normalises to anime1me; a title saying "Anime1.me Extra"
    // still finds it, but by prefix, which is a guess rather than a fact.
    expect(matchSourceHow('Anime1.me Extra: broken').how).toBe('prefix');
  });

  test('an unknown name matches nothing', () => {
    expect(matchSourceHow('Totally Made Up Source: broken')).toEqual({ how: 'none' });
  });

  test('an empty head matches nothing rather than everything', () => {
    expect(matchSourceHow(': broken').how).toBe('none');
  });
});

describe('classifyIssue', () => {
  test('an exact match with a clear problem is confident', () => {
    const c = classifyIssue(issue({ title: 'AniDB [EN]: video will not play' }));
    expect(c.how).toBe('exact');
    expect(c.sourceId).toBe('3556703948634317295');
    expect(c.confident).toBe(true);
    expect(c.problem).toBe('no-video');
    expect(c.lang).toBe('en');
  });

  test('a prefix match is never confident, however clear the problem', () => {
    const c = classifyIssue(issue({ title: 'Anime1.me Extra: video will not play' }));
    expect(c.how).toBe('prefix');
    expect(c.confident).toBe(false);
    expect(c.why).toContain('prefix');
  });

  test('an unmatched source is not confident and keeps a readable name', () => {
    const c = classifyIssue(issue({ title: 'Nonexistent Site [EN]: broken' }));
    expect(c.confident).toBe(false);
    expect(c.sourceId).toBeNull();
    expect(c.proposedName).toBe('Nonexistent Site');
  });

  test('the 18+ flag comes from the catalogue, not the label', () => {
    // The catalogue owns it for a known source, exactly as filing does, so a
    // stray label cannot flip a source's rating for everyone.
    const c = classifyIssue(issue({ title: 'AniDB [EN]: video will not play', labels: [] }));
    expect(c.nsfw).toBe(true);
  });

  test('labels drive the kind', () => {
    expect(classifyIssue(issue({ labels: ['Source request'] })).kind).toBe('request');
    expect(classifyIssue(issue({ labels: ['Domain changed'] })).kind).toBe('domain');
    expect(classifyIssue(issue({ labels: [] })).kind).toBe('bug');
  });

  test('why is written in plain words for a moderator to read', () => {
    const c = classifyIssue(issue({ title: 'Nonexistent Site: broken' }));
    expect(c.why).toBe('No catalogue source matches "Nonexistent Site".');
  });
});

describe('promotion', () => {
  const report = {
    id: 77,
    kind: 'bug' as const,
    title: 'Error 404 (Search)',
    lang: 'en',
    sourceId: '3556703948634317295',
    proposedName: null,
    stage: 'browse' as const,
    cause: 'down' as const,
  };

  test('the title follows the shape the existing backlog uses', () => {
    expect(promoteTitle(report)).toBe("AniDB [EN]: Can't browse, the site is down");
  });

  test('a multi-language report carries no language tag', () => {
    expect(promoteTitle({ ...report, lang: 'all' })).not.toContain('[');
  });

  test('the url targets the template for the kind and carries the backlink', () => {
    const u = new URL(promoteUrl(report, 'yuzono/anime-extensions', 'https://t.example'));
    expect(u.pathname).toBe('/yuzono/anime-extensions/issues/new');
    expect(u.searchParams.get('template')).toBe('01_report_issue.yml');
    expect(u.searchParams.get('body')).toBe('Tracked at https://t.example/report/77');
  });

  test('each kind gets its own template', () => {
    const t = (kind: 'request' | 'domain' | 'removal') =>
      new URL(promoteUrl({ ...report, kind }, 'a/b', 'https://t')).searchParams.get('template');
    expect(t('request')).toBe('02_request_source.yml');
    expect(t('domain')).toBe('03_report_url_change.yml');
    expect(t('removal')).toBe('07_request_removal.yml');
  });

  test('the backlink is read back out of an issue body', () => {
    expect(reportIdFromBody('Tracked at https://t.example/report/77')).toBe(77);
    expect(reportIdFromBody('no link here')).toBeNull();
    expect(reportIdFromBody(null)).toBeNull();
  });
});
