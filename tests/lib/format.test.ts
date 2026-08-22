import { describe, expect, test } from 'bun:test';
import {
  CAUSE_LABELS,
  KIND_LABELS,
  STAGE_FAILURE,
  STATUS_LABELS,
  fixedLabel,
  relativeAge,
  reportHeadline,
  stalledLabel,
} from '../../src/lib/format';

/**
 * A fixed `now`, passed explicitly, because every function here defaults to the
 * wall clock and a test that reads the clock fails at the boundary of a day.
 */
const NOW = 1_700_000_000;
const daysAgo = (d: number) => NOW - d * 86_400;
const hoursAgo = (h: number) => NOW - h * 3600;

describe('relativeAge', () => {
  test('under a day is stated in hours, never in zero hours', () => {
    // Something filed a minute ago reads "1h" rather than "0h": a report that
    // exists has an age, and "0h" reads like a bug.
    expect(relativeAge(NOW, NOW)).toBe('1h');
    expect(relativeAge(hoursAgo(1) + 1, NOW)).toBe('1h');
    expect(relativeAge(hoursAgo(5), NOW)).toBe('5h');
    expect(relativeAge(hoursAgo(23), NOW)).toBe('23h');
  });

  test('a timestamp in the future is clamped rather than shown negative', () => {
    // D1 writes created_at with its own `unixepoch()`, which need not agree
    // with the worker's clock, so a row can legitimately be a second ahead.
    expect(relativeAge(NOW + 600, NOW)).toBe('1h');
  });

  test('days, months and years each take over at their boundary', () => {
    expect(relativeAge(daysAgo(1), NOW)).toBe('1d');
    expect(relativeAge(daysAgo(29), NOW)).toBe('29d');
    expect(relativeAge(daysAgo(30), NOW)).toBe('1mo');
    expect(relativeAge(daysAgo(364), NOW)).toBe('12mo');
    expect(relativeAge(daysAgo(365), NOW)).toBe('1y');
    expect(relativeAge(daysAgo(400), NOW)).toBe('1y');
    expect(relativeAge(daysAgo(730), NOW)).toBe('2y');
  });
});

describe('stalledLabel', () => {
  test('nothing under 90 days is called stalled', () => {
    // Median open age on this board is 69 days, so being old is not
    // remarkable. Labelling everything would make the label mean nothing.
    expect(stalledLabel(NOW, NOW)).toBeNull();
    expect(stalledLabel(daysAgo(1), NOW)).toBeNull();
    expect(stalledLabel(daysAgo(69), NOW)).toBeNull();
    expect(stalledLabel(daysAgo(89), NOW)).toBeNull();
    expect(stalledLabel(daysAgo(89.9), NOW)).toBeNull();
  });

  test('months from 90 days up', () => {
    expect(stalledLabel(daysAgo(90), NOW)).toBe('waiting 3 months');
    expect(stalledLabel(daysAgo(180), NOW)).toBe('waiting 6 months');
    expect(stalledLabel(daysAgo(359), NOW)).toBe('waiting 11 months');
  });

  test('years once twelve months are up', () => {
    expect(stalledLabel(daysAgo(360), NOW)).toBe('waiting 1y');
    expect(stalledLabel(daysAgo(400), NOW)).toBe('waiting 1y');
    expect(stalledLabel(daysAgo(720), NOW)).toBe('waiting 2y');
  });
});

describe('reportHeadline', () => {
  /**
   * The backlog came over from GitHub with HTTP jargon for titles, while a
   * report filed here is titled with the plain-language problem it was filed
   * under. Both land on the same board, so the imported ones are rebuilt from
   * `stage` and `cause`.
   */
  test('an imported "Error <number>" title is rewritten in plain language', () => {
    expect(
      reportHeadline({ title: 'Error 404 (Search)', stage: 'browse', cause: 'down' }),
    ).toBe("Can't browse, the site is down");
    expect(
      reportHeadline({ title: 'Error 503', stage: 'browse', cause: 'cloudflare' }),
    ).toBe("Can't browse, Cloudflare is blocking it");
    expect(
      reportHeadline({ title: 'Error 404 (Episodes)', stage: 'episodes', cause: 'redesign' }),
    ).toBe('No episodes, the site was redesigned');
  });

  test('a video failure caused by the extractor does not say it twice', () => {
    // "No video, no video loads" is one thing said twice, so that pair
    // collapses to the wording /new uses for the identical problem.
    expect(
      reportHeadline({ title: 'Error 503 & Error 444 (Videos)', stage: 'video', cause: 'extractor' }),
    ).toBe("Video won't play");
  });

  test("`other` contributes nothing, because it says nothing", () => {
    // "Can't browse, it's something else" is worse than "Can't browse".
    expect(reportHeadline({ title: 'Error 500', stage: 'browse', cause: 'other' })).toBe(
      "Can't browse",
    );
    expect(reportHeadline({ title: 'Error 500', stage: 'video', cause: 'other' })).toBe('No video');
  });

  test('a null stage lets the cause be the whole sentence, capitalised', () => {
    // With no stage there is no symptom to lead with, so the clause starts the
    // sentence and has to be capitalised — it was written to follow a comma.
    expect(reportHeadline({ title: 'Error 403', stage: null, cause: 'cloudflare' })).toBe(
      'Cloudflare is blocking it',
    );
    expect(reportHeadline({ title: 'Error 404', stage: null, cause: 'domain' })).toBe(
      'The domain changed',
    );
    expect(reportHeadline({ title: 'Error 404', stage: null, cause: 'geo' })).toBe(
      "It's geo-blocked",
    );
  });

  test('with nothing plain to build from, the jargon beats an empty headline', () => {
    expect(reportHeadline({ title: 'Error 500', stage: null, cause: 'other' })).toBe('Error 500');
    expect(reportHeadline({ title: 'Error 500', stage: null, cause: null })).toBe('Error 500');
  });

  test('a title a person wrote is returned untouched', () => {
    // Always better than one generated here, and the check is anchored to
    // "Error <number>" so an ordinary sentence mentioning an error survives.
    expect(
      reportHeadline({ title: "Video won't play", stage: 'video', cause: 'extractor' }),
    ).toBe("Video won't play");
    expect(reportHeadline({ title: 'Search returns nothing', stage: 'browse', cause: 'other' })).toBe(
      'Search returns nothing',
    );
    expect(reportHeadline({ title: 'Errors everywhere', stage: 'video', cause: 'extractor' })).toBe(
      'Errors everywhere',
    );
    expect(reportHeadline({ title: 'Error page shows up', stage: null, cause: 'down' })).toBe(
      'Error page shows up',
    );
  });

  test('every stage and cause the schema allows produces a non-empty headline', () => {
    // Exhaustive, because a missing entry in either lookup table would render
    // "undefined" into the board rather than throwing.
    const stages = [null, 'browse', 'episodes', 'video'] as const;
    for (const stage of stages) {
      for (const cause of Object.keys(CAUSE_LABELS) as (keyof typeof CAUSE_LABELS)[]) {
        const out = reportHeadline({ title: 'Error 500', stage, cause });
        expect(out).toBeTruthy();
        expect(out).not.toContain('undefined');
      }
      expect(reportHeadline({ title: 'Error 500', stage, cause: null })).toBeTruthy();
    }
  });
});

describe('label tables', () => {
  test('the stage tables cover the same three stages', () => {
    expect(Object.keys(STAGE_FAILURE).sort()).toEqual(['browse', 'episodes', 'video']);
  });

  test('no label is empty', () => {
    // These are read straight into the page; an empty string is an invisible row.
    for (const table of [CAUSE_LABELS, KIND_LABELS, STATUS_LABELS, STAGE_FAILURE]) {
      for (const [key, value] of Object.entries(table)) {
        expect(value, `label for ${key}`).toBeTruthy();
      }
    }
  });
});

describe('fixedLabel', () => {
  const now = 1_700_000_000;
  const daysAgo = (d: number) => now - d * 86_400;

  test('a fixed report says when it was fixed', () => {
    expect(fixedLabel('fixed', daysAgo(21), now)).toBe('Fixed 21d ago');
    expect(fixedLabel('fixed', daysAgo(400), now)).toBe('Fixed 1y ago');
  });

  test('only fixed gets a date', () => {
    // "Won't fix 3mo ago" says nothing useful about when a decision stopped
    // mattering, and those rows keep the plain label instead.
    expect(fixedLabel('wont_fix', daysAgo(90), now)).toBeNull();
    expect(fixedLabel('duplicate', daysAgo(90), now)).toBeNull();
    expect(fixedLabel('open', daysAgo(90), now)).toBeNull();
    expect(fixedLabel('confirmed', daysAgo(90), now)).toBeNull();
  });

  test('no fix date means no phrase, so the row falls back to the pill', () => {
    // 468 rows came over from the issue backlog already closed, and not all of
    // them carry a status_changed_at.
    expect(fixedLabel('fixed', null, now)).toBeNull();
  });
});
