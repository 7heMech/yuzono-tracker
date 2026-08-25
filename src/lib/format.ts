import { OTHER_STATUSES } from './db/schema';
import type { BoardState } from './queries';

export function relativeAge(createdAt: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - createdAt);
  const d = Math.floor(s / 86_400);
  if (d < 1) return `${Math.max(1, Math.floor(s / 3600))}h`;
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

/**
 * A fixed day, said once: "24 August 2026".
 *
 * The relative formatters above are wrong for anything baked into a
 * prerendered page. /source/<slug>/ rebuilds only on deploy, so a "removed two
 * days ago" rendered at build time would freeze there and lie a little more
 * every day after. Assembled from formatToParts rather than formatted whole,
 * because plain 'en' orders month-first ("August 24, 2026") and this reads as
 * a day. timeZone is pinned to UTC because an ISO-only date parses to midnight
 * UTC — left to the machine's zone, a build in the Americas would print the
 * previous day.
 */
export function absoluteDate(iso: string): string {
  const parts = new Map(
    new Intl.DateTimeFormat('en', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value] as const),
  );
  return `${parts.get('day')} ${parts.get('month')} ${parts.get('year')}`;
}

export const STAGE_LABELS = {
  browse: 'Browse',
  episodes: 'Episodes',
  video: 'Video',
} as const;

/** Said as a sentence fragment, so a row needs no key to read. */
export const STAGE_FAILURE = {
  browse: "Can't browse",
  episodes: 'No episodes',
  video: 'No video',
} as const;

/**
 * Only the genuinely neglected get called out, and in words. Median open age
 * here is 69 days, so "old" is not remarkable — "ignored" is.
 */
export function stalledLabel(createdAt: number, now = Date.now() / 1000): string | null {
  const days = (now - createdAt) / 86_400;
  if (days < 90) return null;
  const months = Math.floor(days / 30);
  return months >= 12 ? `waiting ${Math.floor(months / 12)}y` : `waiting ${months} months`;
}

/**
 * When a closed report was closed, as one phrase rather than a badge plus a
 * date.
 *
 * The row used to print the "Fixed" pill beside the age of the *report*, which
 * on the fixed board read as "Fixed · 8mo ago" for something fixed last week.
 * And stalledLabel above answers from created_at alone, so a closed report old
 * enough to qualify was labelled "waiting 5 months" after it had been dealt
 * with.
 *
 * wont_fix and duplicate are covered here too, which reverses the old rule
 * that only `fixed` got a date. On the Other board those rows sit under a list
 * ordered by when things closed, so without this they fell back to
 * relativeAge(createdAt) and dated every row by when it was filed — the same
 * defect in the other direction. The word comes from statusLabel, so a request
 * reads "Won't add" where a bug reads "Won't fix"; `kind` therefore trails as
 * the last parameter, reversing statusLabel's argument order.
 *
 * Rows whose status_changed_at was never set return null and keep the plain
 * status word rather than a fabricated date. updated_at is no substitute:
 * reconcileNsfw touches it on every pass, so it is not a closing date.
 */
export function fixedLabel(
  status: string,
  statusChangedAt: number | null,
  now = Date.now() / 1000,
  kind?: string | null,
): string | null {
  if (!statusChangedAt) return null;
  const closed = status === 'fixed' || (OTHER_STATUSES as readonly string[]).includes(status);
  if (!closed) return null;
  return `${statusLabel(status, kind)} ${relativeAge(statusChangedAt, now)} ago`;
}

export const CAUSE_LABELS = {
  redesign: 'Site redesigned',
  domain: 'Domain changed',
  cloudflare: 'Cloudflare',
  down: 'Site down',
  geo: 'Geo-blocked',
  extractor: 'No videos',
  other: 'Other',
} as const;

/**
 * The same seven causes said as a clause that can follow a symptom, which is a
 * different job from CAUSE_LABELS: those are values in a fact list and tags in
 * a row, where "Site down" is exactly right, while a headline needs something
 * that reads on from "Can't browse — ". Lower case so the join is one
 * sentence; "Cloudflare" keeps its capital because it is a name. `other`
 * carries no information at all, so it contributes nothing rather than a
 * meaningless "it's something else".
 */
const CAUSE_CLAUSE = {
  redesign: 'the site was redesigned',
  domain: 'the domain changed',
  cloudflare: 'Cloudflare is blocking it',
  down: 'the site is down',
  geo: "it's geo-blocked",
  extractor: 'no video loads',
  other: null,
} as const satisfies Record<keyof typeof CAUSE_LABELS, string | null>;

/**
 * What to lead with when a report's stored title is imported HTTP jargon.
 *
 * The backlog came over from GitHub with titles like "Error 503 & Error 444
 * (Videos)" and "Error 404 (Search)", while a report filed here is titled with
 * the plain-language problem it was filed under ("Video won't play"). Visitors
 * land on both from the same board and from Discord links, so the imported
 * ones are rebuilt from `stage` and `cause` — the two columns that do hold
 * plain words. Anything that does not start "Error <number>" is returned
 * untouched: a title a person wrote is always better than one generated here,
 * and the stored title stays visible on the detail page for cross-referencing
 * the GitHub issue.
 */
export function reportHeadline(r: {
  title: string;
  stage: 'browse' | 'episodes' | 'video' | null;
  cause: keyof typeof CAUSE_LABELS | null;
}): string {
  if (!/^Error \d+/.test(r.title)) return r.title;

  // An extractor failure *is* a video failure, so "No video, no video loads"
  // would say one thing twice. That pair collapses to the wording /new uses
  // for the identical problem, which is also what ReportRow's `redundant`
  // check exists to avoid on the row.
  if (r.stage === 'video' && r.cause === 'extractor') return "Video won't play";

  const symptom = r.stage ? STAGE_FAILURE[r.stage] : null;
  const clause = r.cause ? CAUSE_CLAUSE[r.cause] : null;
  if (symptom && clause) return `${symptom}, ${clause}`;
  if (symptom) return symptom;
  // No stage recorded — the cause is the whole sentence, so it starts one.
  if (clause) return clause[0].toUpperCase() + clause.slice(1);
  // Nothing plain to build from. The jargon beats an empty headline.
  return r.title;
}

export const KIND_LABELS = {
  bug: 'Broken',
  request: 'Source request',
  domain: 'Domain change',
  dead: 'Dead source',
  feature: 'Feature',
  meta: 'Meta',
  removal: 'Removal',
} as const;

export const STATUS_LABELS = {
  open: 'Open',
  confirmed: 'Confirmed',
  in_progress: 'Being fixed',
  fixed: 'Fixed',
  wont_fix: "Won't fix",
  duplicate: 'Duplicate',
} as const;

export function statusLabel(status: string, kind?: string | null): string {
  if (status === 'wont_fix' && kind === 'request') return "Won't add";
  return (STATUS_LABELS as Record<string, string>)[status] ?? status;
}

/* --- board views ---------------------------------------------------------- */

/** Which half of the catalogue a board collects. Matches queries.BoardFilter. */
export type BoardFamily = 'broken' | 'wanted';

/**
 * Everything a page says about the view it is showing.
 *
 * This used to be sixteen `state === 'fixed' ? … : …` ternaries spread across
 * two pages, which is how a third view would have ended up titled with the
 * first one's words: miss one ternary and nothing fails, it just lies. One
 * descriptor per view, per family, is what makes adding or renaming a view a
 * data change instead of an audit.
 */
export interface BoardViewCopy {
  /** The chip label in FilterBar's state group. */
  chip: string;
  /** The `<title>` and the `<h1>`, which name what is actually listed. */
  heading: string;
  /** The sentence under the h1. */
  lede: string;
  /** Empty-state headline and body — body split on whether filters narrowed
      the view or the view is genuinely empty, which the boards word apart. */
  emptyTitle: string;
  emptyFiltered: string;
  emptyAlone: string;
  /** Where an empty board sends people, and whether that is the page's own
      ask (`primary`) or a pointer elsewhere. */
  cta: { href: string; label: string; primary?: boolean };
  /** The order this view leads with; also the fallback for sorts it cannot
      honour. Closed views share `'fixed'`: most recently closed first. */
  defaultSort: 'demand' | 'fixed';
  /** What the pager counts in — "Showing 1–60 of 137 {pagerNoun}". */
  pagerNoun: string;
}

const BROKEN_VIEWS: Record<BoardState, BoardViewCopy> = {
  open: {
    chip: 'Open',
    heading: 'Broken sources',
    lede: 'Ranked by how many people are hit. Reporting something already listed just adds you to it.',
    emptyTitle: 'Nothing broken here',
    emptyFiltered: 'No open reports match these filters. Try widening them.',
    emptyAlone: 'No open reports yet. If a source is broken for you, be the first to say so.',
    cta: { href: '/new', label: 'Report a broken source', primary: true },
    defaultSort: 'demand',
    pagerNoun: 'open reports',
  },
  fixed: {
    chip: 'Fixed',
    heading: 'Fixed sources',
    lede: 'Reports that have been fixed, most recently closed first. Update the extension and the fix is yours.',
    emptyTitle: 'Nothing fixed here yet',
    emptyFiltered: 'No fixed reports match these filters. Try widening them.',
    emptyAlone: 'No report has been marked fixed yet.',
    cta: { href: '/', label: 'See what is still broken' },
    defaultSort: 'fixed',
    pagerNoun: 'fixed reports',
  },
  other: {
    chip: 'Other',
    heading: "Won't fix and duplicates",
    lede: 'Reports closed without a fix: decided against, or merged into another report. They stay listed so a filed report never dead-ends.',
    emptyTitle: 'Nothing here yet',
    emptyFiltered: 'No closed reports match these filters. Try widening them.',
    emptyAlone: 'Nothing has been closed without a fix yet.',
    cta: { href: '/', label: 'See what is still open' },
    defaultSort: 'fixed',
    pagerNoun: 'closed without a fix',
  },
};

const WANTED_VIEWS: Record<BoardState, BoardViewCopy> = {
  open: {
    chip: 'Open',
    heading: 'Requests',
    lede: 'Sources people want added, and changes they want to sources that already exist, ranked by demand.',
    emptyTitle: 'No open requests',
    emptyFiltered: 'No open requests match these filters. Try widening them.',
    emptyAlone: 'No open requests yet. If a source you want is missing, be the first to ask.',
    cta: { href: '/request', label: 'Make a request', primary: true },
    defaultSort: 'demand',
    pagerNoun: 'open requests',
  },
  fixed: {
    chip: 'Fixed',
    heading: 'Requests that got built',
    lede: 'Requests that have been built, most recently finished first.',
    emptyTitle: 'Nothing added yet',
    emptyFiltered: 'No built requests match these filters. Try widening them.',
    emptyAlone: 'Nothing has been built yet.',
    cta: { href: '/requests', label: 'See what people are asking for' },
    defaultSort: 'fixed',
    pagerNoun: 'added sources',
  },
  other: {
    chip: 'Other',
    heading: "Won't add and duplicates",
    lede: 'Requests turned down without being built, or marked as duplicates of another ask.',
    emptyTitle: 'Nothing here yet',
    emptyFiltered: 'Nothing here matches these filters. Try widening them.',
    emptyAlone: 'Nothing has been turned down yet.',
    cta: { href: '/requests', label: 'See what people are asking for' },
    defaultSort: 'fixed',
    pagerNoun: 'closed without being built',
  },
};

export const BOARD_VIEW_COPY: Record<BoardFamily, Record<BoardState, BoardViewCopy>> = {
  broken: BROKEN_VIEWS,
  wanted: WANTED_VIEWS,
};
