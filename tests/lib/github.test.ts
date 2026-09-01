import { describe, expect, test } from 'bun:test';
import {
  classifyIssue,
  closedStatusFor,
  isMismatch,
  matchSourceHow,
  nsfwFor,
  promoteTitle,
  promoteUrl,
  reportIdFromBody,
  requestedName,
  sign,
  sourceLinkFromBody,
  signatureHex,
  transitionFor,
  verifySignature,
  type IssueSnapshot,
  type PromotableReport,
} from '../../src/lib/github';
import { getSource, REMOVED_SOURCES } from '../../src/lib/sources';

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

  test('classifies "No Results Found" as confident no-browse bug report', () => {
    const c = classifyIssue(
      issue({
        number: 808,
        title: 'AniZone [Multi]: No Results Found',
        labels: ['Bug', 'Valid'],
      }),
    );
    expect(c.how).toBe('exact');
    expect(c.sourceId).not.toBeNull();
    expect(c.stage).toBe('browse');
    expect(c.problem).toBe('no-browse');
    expect(c.confident).toBe(true);
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

  test('a matched source overrides the label in both directions', () => {
    // The half that was actually broken in production. scripts/import-issues.ts
    // read the label unconditionally, so hanime.tv — whose issue carried no
    // `18+` label — was stored as safe and its report sat on the default board.
    // 46 of 174 catalogue-backed rows disagreed with the catalogue this way.
    const adultNoLabel = classifyIssue(issue({ title: 'hanime.tv [EN]: site is down', labels: [] }));
    expect(adultNoLabel.sourceId).not.toBeNull();
    expect(adultNoLabel.nsfw).toBe(true);

    // And the converse: a label on a source the catalogue calls safe does not
    // hide it. The label is not a second opinion, it is ignored outright.
    const tameWithLabel = classifyIssue(
      issue({ title: 'French Anime [FR]: video will not play', labels: ['18+'] }),
    );
    expect(tameWithLabel.sourceId).not.toBeNull();
    expect(tameWithLabel.nsfw).toBe(false);
  });

  test('with no catalogue entry the label is all there is', () => {
    // A request for a site that does not exist yet, or an issue whose source
    // could not be matched. Here the label is the only signal, so it is trusted.
    const c = classifyIssue(
      issue({ title: 'Nonexistent Site [EN]: broken', labels: ['18+'] }),
    );
    expect(c.sourceId).toBeNull();
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

  test('a source request prefills the form fields', () => {
    const req: PromotableReport = {
      id: 478,
      kind: 'request' as const,
      title: 'Add AniWaves',
      lang: 'en',
      sourceId: null,
      proposedName: 'AniWaves',
      stage: null,
      cause: null,
      proposedUrl: 'https://aniwaves.ru',
      body: null,
      nsfw: false,
    };
    const u = new URL(promoteUrl(req, 'yuzono/anime-extensions', 'https://t.example'));
    expect(u.searchParams.get('name')).toBe('AniWaves');
    expect(u.searchParams.get('link')).toBe('https://aniwaves.ru');
    expect(u.searchParams.get('language')).toBe('English');
    expect(u.searchParams.get('other-details')).toBe('Tracked at https://t.example/report/478');
    // body kept for fallback, even though forms ignore it
    expect(u.searchParams.get('body')).toBe('Tracked at https://t.example/report/478');
  });

  test('a source request includes the NSFW hint and body in other-details', () => {
    const req: PromotableReport = {
      id: 10,
      kind: 'request' as const,
      title: 'Add Example',
      lang: 'en',
      sourceId: null,
      proposedName: 'Example',
      stage: null,
      cause: null,
      proposedUrl: 'https://example.com',
      body: 'Please add this site',
      nsfw: true,
    };
    const u = new URL(promoteUrl(req, 'a/b', 'https://t'));
    const other = u.searchParams.get('other-details')!;
    expect(other).toContain('Please add this site');
    expect(other).toContain('18+/NSFW = yes');
    expect(other).toContain('Tracked at https://t/report/10');
  });

  test('a bug report prefills source, language and app fields', () => {
    const bug: PromotableReport = {
      id: 77,
      kind: 'bug' as const,
      title: 'Error 404 (Search)',
      lang: 'en',
      sourceId: '3556703948634317295',
      proposedName: null,
      stage: 'browse' as const,
      cause: 'down' as const,
      body: 'Search returns 404',
      extVersion: '14.3',
      appName: 'Anikku',
      appVersion: '0.18.3',
    };
    const u = new URL(promoteUrl(bug, 'yuzono/anime-extensions', 'https://t.example'));
    expect(u.searchParams.get('source')).toBe('AniDB 14.3 (English)');
    expect(u.searchParams.get('language')).toBe('English');
    expect(u.searchParams.get('which-app')).toBe('Anikku');
    expect(u.searchParams.get('app-version')).toBe('0.18.3');
    expect(u.searchParams.get('other-details')).toContain('Search returns 404');
    expect(u.searchParams.get('other-details')).toContain('Tracked at https://t.example/report/77');
  });

  test('a domain change prefills the new address', () => {
    const dom: PromotableReport = {
      id: 5,
      kind: 'domain' as const,
      title: 'Moved',
      lang: 'en',
      sourceId: '3556703948634317295',
      proposedName: null,
      stage: 'browse' as const,
      cause: 'domain' as const,
      newUrl: 'https://new.example',
    };
    const u = new URL(promoteUrl(dom, 'a/b', 'https://t'));
    expect(u.searchParams.get('link')).toBe('https://new.example');
    expect(u.searchParams.get('source')).toContain('AniDB');
  });

  test('a feature request prefills source and feature-description', () => {
    const feat: PromotableReport = {
      id: 20,
      kind: 'feature' as const,
      title: 'Add login',
      lang: 'en',
      sourceId: '3556703948634317295',
      proposedName: null,
      stage: null,
      cause: null,
      body: 'Should support login via OAuth',
    };
    const u = new URL(promoteUrl(feat, 'a/b', 'https://t'));
    expect(u.searchParams.get('source')).toBe('AniDB');
    expect(u.searchParams.get('language')).toBe('English');
    expect(u.searchParams.get('feature-description')).toBe('Should support login via OAuth');
    expect(u.searchParams.get('other-details')).toBe('Tracked at https://t/report/20');
  });

  test('a long body is truncated but the backlink survives', () => {
    const req: PromotableReport = {
      id: 99,
      kind: 'request' as const,
      title: 'Add Long',
      lang: 'en',
      sourceId: null,
      proposedName: 'Long',
      stage: null,
      cause: null,
      proposedUrl: 'https://long.example',
      body: 'x'.repeat(5000),
      nsfw: true,
    };
    const other = new URL(promoteUrl(req, 'a/b', 'https://t')).searchParams.get('other-details')!;
    expect(other).toContain('Tracked at https://t/report/99');
    expect(other).toContain('18+/NSFW = yes');
    expect(other.length).toBeLessThanOrEqual(1500);
    expect(encodeURIComponent(other).length).toBeLessThanOrEqual(1500);
  });

  test('non-ASCII body does not blow the encoded limit', () => {
    const req: PromotableReport = {
      id: 101,
      kind: 'request' as const,
      title: 'Add CJK',
      lang: 'en',
      sourceId: null,
      proposedName: 'CJK',
      stage: null,
      cause: null,
      proposedUrl: 'https://cjk.example',
      body: '汉'.repeat(1000),
      nsfw: true,
    };
    const other = new URL(promoteUrl(req, 'a/b', 'https://t')).searchParams.get('other-details')!;
    expect(other).toContain('Tracked at https://t/report/101');
    expect(encodeURIComponent(other).length).toBeLessThanOrEqual(1500);
  });

  test('total URL stays within limit even with long fields', () => {
    const req: PromotableReport = {
      id: 102,
      kind: 'request' as const,
      title: 'Add Long ' + 'A'.repeat(200),
      lang: 'en',
      sourceId: null,
      proposedName: 'Long',
      stage: null,
      cause: null,
      proposedUrl: 'https://example.com/' + 'p/'.repeat(200),
      body: 'y'.repeat(5000),
      nsfw: false,
    };
    const url = promoteUrl(req, 'a/b', 'https://t');
    expect(url.length).toBeLessThanOrEqual(8000);
    const parsed = new URL(url);
    const other = parsed.searchParams.get('other-details') ?? parsed.searchParams.get('body') ?? '';
    expect(other).toContain('Tracked at https://t/report/102');
  });

  test('oversized name and source are trimmed to fit', () => {
    const req: PromotableReport = {
      id: 103,
      kind: 'request' as const,
      title: 'Add ' + 'A'.repeat(10000),
      lang: 'en',
      sourceId: null,
      proposedName: 'A'.repeat(10000),
      stage: null,
      cause: null,
      proposedUrl: 'https://example.com/' + 'p/'.repeat(500),
      body: 'x'.repeat(500),
      nsfw: false,
    };
    const url = promoteUrl(req, 'a/b', 'https://t');
    expect(url.length).toBeLessThanOrEqual(8000);
    const parsed = new URL(url);
    const name = parsed.searchParams.get('name') ?? '';
    const other = parsed.searchParams.get('other-details') ?? '';
    expect(other).toContain('Tracked at https://t/report/103');
    expect(encodeURIComponent(name).length).toBeLessThan(8000);

    const bug: PromotableReport = {
      id: 104,
      kind: 'bug' as const,
      title: 'Bug ' + 'B'.repeat(10000),
      lang: 'en',
      sourceId: '3556703948634317295',
      proposedName: null,
      stage: 'browse' as const,
      cause: 'down' as const,
      body: 'y'.repeat(500),
      extVersion: '1.0',
      appName: 'App',
      appVersion: '1.0',
    };
    const url2 = promoteUrl(bug, 'a/b', 'https://t');
    expect(url2.length).toBeLessThanOrEqual(8000);
    expect(new URL(url2).searchParams.get('other-details')).toContain('Tracked at https://t/report/104');
  });
});

describe('nsfwFor', () => {
  /**
   * The rule three callers answer to: `classifyIssue` above, the one-off
   * importer in scripts/import-issues.ts, and `reconcileNsfw` in
   * lib/github-sync.ts. They disagreed for months — the importer trusted the
   * label even when it had matched a source — which is the whole reason this is
   * a named, exported function rather than an expression in one of them.
   */
  test('a catalogue entry decides, whatever the labels say', () => {
    expect(nsfwFor({ nsfw: true }, [])).toBe(true);
    expect(nsfwFor({ nsfw: true }, ['18+'])).toBe(true);
    expect(nsfwFor({ nsfw: false }, ['18+'])).toBe(false);
    expect(nsfwFor({ nsfw: false }, [])).toBe(false);
  });

  test('with no entry, the label speaks', () => {
    // Both spellings of absent: a request has no source at all, and an
    // unmatched issue resolves the lookup to undefined.
    for (const missing of [undefined, null]) {
      expect(nsfwFor(missing, ['18+'])).toBe(true);
      expect(nsfwFor(missing, [])).toBe(false);
      expect(nsfwFor(missing, ['Source request', '18+'])).toBe(true);
    }
  });

  test('only the exact label counts', () => {
    // Guards the `labels LIKE '%"18+"%'` test reconcileNsfw runs against the
    // stored JSON array: a label that merely contains the digits must not read
    // as the flag.
    expect(nsfwFor(null, ['18'])).toBe(false);
    expect(nsfwFor(null, ['NSFW'])).toBe(false);
    expect(nsfwFor(null, ['not-18+'])).toBe(false);
    expect(nsfwFor(null, ['18+ '])).toBe(false);
  });
});

describe('sourceLinkFromBody', () => {
  /** What 02_request_source.yml actually produces, verbatim from issue #796. */
  const REQUEST = [
    '### Source name',
    '',
    'Playvids',
    '',
    '### Source link',
    '',
    'https://www.playvids.com/',
    '',
    '### Source language',
    '',
    'English ',
  ].join('\n');

  test('reads the address the form asked for', () => {
    // normaliseUrl keeps the origin and drops the trailing slash, so this is
    // the same string /request would have stored for the same site.
    expect(sourceLinkFromBody(REQUEST)).toBe('https://www.playvids.com');
  });

  test('a bare host is still an address', () => {
    // People type the domain, and the form does not stop them.
    expect(sourceLinkFromBody('### Source link\n\nanimefire.plus\n')).toBe(
      'https://animefire.plus',
    );
  });

  test('a markdown link gives up its target', () => {
    expect(sourceLinkFromBody('### Source link\n\n[AnimeFire](https://animefire.plus/en)')).toBe(
      'https://animefire.plus/en',
    );
  });

  test('an unfilled section is not an address', () => {
    // `_No response_` is what GitHub writes for a skipped field, and the next
    // heading is what an emptied one leaves behind. Neither is a site.
    expect(sourceLinkFromBody('### Source link\n\n_No response_\n')).toBeNull();
    expect(sourceLinkFromBody('### Source link\n\n### Source language\n\nEnglish')).toBeNull();
  });

  test('a body with no such section, and no body at all', () => {
    // Bug reports have no address, and /review rebuilds snapshots with no body
    // — see snapshotOf in lib/github-sync.ts.
    expect(sourceLinkFromBody('### Source information\n\nTorrentio 14.6')).toBeNull();
    expect(sourceLinkFromBody(null)).toBeNull();
    expect(sourceLinkFromBody('')).toBeNull();
  });

  test('only requests are classified with an address', () => {
    // proposed_url carries the request dedupe index, so a link in a bug
    // report's body must never land in it.
    const base: IssueSnapshot = {
      number: 1,
      title: 'Playvids [EN]: Source Request',
      state: 'open',
      stateReason: null,
      body: REQUEST,
      labels: ['Source request'],
      createdAt: 0,
      updatedAt: 0,
      reactions: 0,
    };
    expect(classifyIssue(base).proposedUrl).toBe('https://www.playvids.com');
    expect(classifyIssue({ ...base, labels: [] }).proposedUrl).toBeNull();
  });
});

describe('requestedName', () => {
  /**
   * Every string below is a real request title from the backlog. The rows they
   * produced read "Add PirateXplay · Add Add PirateXplay", because the name and
   * the headline are built from the same string and the headline prefixes the
   * verb the title already had in it.
   */
  test('takes the ask off the front', () => {
    expect(requestedName('Add PirateXplay')).toBe('PirateXplay');
    expect(requestedName('Add Braflix')).toBe('Braflix');
    expect(requestedName('Add M.Kissa')).toBe('M.Kissa');
    expect(requestedName('Add Source Crunchyroll')).toBe('Crunchyroll');
    expect(requestedName('Please add some hindi source also')).toBe('some hindi source also');
    expect(requestedName('Source request for movie box, anidb')).toBe('movie box, anidb');
  });

  test('and the manners off the end', () => {
    expect(requestedName('Add LaMovie please')).toBe('LaMovie');
    expect(requestedName('Add LaMovie, thanks!')).toBe('LaMovie');
  });

  test('null when the title is already just a name', () => {
    // The caller keeps the raw title for null, so these rows are untouched.
    expect(requestedName('AnimeFire')).toBeNull();
    expect(requestedName('The Anime Place')).toBeNull();
    // "add" and "new" inside a word, and in front of one they are not filler
    // for: three real names that must survive.
    expect(requestedName('Addic7ed')).toBeNull();
    expect(requestedName('Adventure Time')).toBeNull();
    expect(requestedName('New Anime Site')).toBeNull();
  });

  test('null when the title names no site at all', () => {
    expect(requestedName('Source request')).toBeNull();
    expect(requestedName('source request')).toBeNull();
    expect(requestedName('New Source')).toBeNull();
    expect(requestedName('Adding source request')).toBeNull();
    expect(requestedName('')).toBeNull();
  });

  test('a stripped phrase must end at a word, not mid-name', () => {
    // "New Source" is filler, but not when it is the first half of
    // "New Source/extension" — the slash is a word boundary and not a word end.
    expect(requestedName('Request to add New Source/extension for movie')).toBe(
      'New Source/extension for movie',
    );
  });

  test('the name and the headline are built from one string', () => {
    const issue: IssueSnapshot = {
      number: 187,
      title: 'Add PirateXplay',
      state: 'open',
      stateReason: null,
      body: null,
      labels: ['Source request'],
      createdAt: 0,
      updatedAt: 0,
      reactions: 0,
    };
    const c = classifyIssue(issue);
    expect(c.proposedName).toBe('PirateXplay');
    expect(c.title).toBe('Add PirateXplay');
  });

  test('a bug title is left alone, ask words and all', () => {
    // requestedName only runs for requests: on every other kind the head is a
    // source name already, and "Addic7ed: Error 404" must not lose its source.
    const issue: IssueSnapshot = {
      number: 1,
      title: 'Addic7ed [EN]: Error 404 (Search)',
      state: 'open',
      stateReason: null,
      body: null,
      labels: [],
      createdAt: 0,
      updatedAt: 0,
      reactions: 0,
    };
    expect(classifyIssue(issue).proposedName).toBe('Addic7ed');
  });
});

describe('tombstoned sources', () => {
  /**
   * NoobSubs is the source behind report 18. It left the upstream index on
   * 2026-08-24; without a tombstone its name vanished from every surface at
   * once and a new upstream issue about it would have spawned an orphan
   * instead of joining the existing report.
   */
  const NOOBSUBS = '5343978110335507456';
  // Gate on this exact tombstone. A live NoobSubs means the source came back
  // and these assertions describe a dead row that no longer is one — skip.
  // Absent entirely means the backfill was deleted, which must fail, not skip.
  const noobsubsGone = (() => {
    const s = getSource(NOOBSUBS);
    return s === undefined || s.removed !== undefined;
  })();

  test.skipIf(!noobsubsGone)('an upstream issue still lands on it', () => {
    expect(matchSourceHow('NoobSubs: source is down')).toEqual({
      sourceId: NOOBSUBS,
      how: 'exact',
    });
  });

  test.skipIf(!noobsubsGone)(
    'classifyIssue explains the removal to /review',
    () => {
      const c = classifyIssue(issue({ title: 'NoobSubs: source is down' }));
      expect(c.how).toBe('exact');
      expect(c.sourceId).toBe(NOOBSUBS);
      expect(c.why).toBe(
        'Matched NoobSubs exactly. That source was removed from the catalogue on 24 August 2026.',
      );
    },
  );

  test.skipIf(!noobsubsGone)(
    'promoteTitle renders the tombstoned name rather than Unknown',
    () => {
      expect(
        promoteTitle({
          id: 18,
          kind: 'dead',
          title: 'Error 404 (Search)',
          lang: 'en',
          sourceId: NOOBSUBS,
          proposedName: null,
          stage: 'browse',
          cause: 'down',
        }),
      ).toBe("NoobSubs [EN]: Can't browse, the site is down");
    },
  );

  test.skipIf(!noobsubsGone)(
    'the nsfw flag comes from the last known catalogue value',
    () => {
      const dead = REMOVED_SOURCES.find((s) => s.id === NOOBSUBS)!;
      expect(nsfwFor(dead, [])).toBe(dead.nsfw);
    },
  );
});
