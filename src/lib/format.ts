export function relativeAge(createdAt: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - createdAt);
  const d = Math.floor(s / 86_400);
  if (d < 1) return `${Math.max(1, Math.floor(s / 3600))}h`;
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
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
 * When a fixed report was fixed, as one phrase rather than a badge plus a date.
 *
 * The row used to print the "Fixed" pill beside the age of the *report*, which
 * on the fixed board read as "Fixed · 8mo ago" for something fixed last week.
 * And stalledLabel above answers from created_at alone, so a closed report old
 * enough to qualify was labelled "waiting 5 months" after it had been dealt
 * with. Only `fixed` gets a date here: "Won't fix 3mo ago" says nothing useful
 * about when a decision stopped mattering, so those keep the plain word.
 */
export function fixedLabel(
  status: string,
  statusChangedAt: number | null,
  now = Date.now() / 1000,
): string | null {
  if (status !== 'fixed' || !statusChangedAt) return null;
  return `Fixed ${relativeAge(statusChangedAt, now)} ago`;
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
