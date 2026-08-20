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

export const CAUSE_LABELS = {
  redesign: 'Site redesigned',
  domain: 'Domain changed',
  cloudflare: 'Cloudflare',
  down: 'Site down',
  geo: 'Geo-blocked',
  extractor: 'No videos',
  other: 'Other',
} as const;

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
