/**
 * Age is the pathology this board exists to expose: the median open issue on
 * the repo is 69 days old and p90 is 147, so a timestamp alone hides the story.
 * These thresholds drive the rot rail.
 */
export const ROT_THRESHOLDS_DAYS = [7, 30, 90] as const;

export type RotLevel = 0 | 1 | 2 | 3;

export function rotLevel(createdAt: number, now = Date.now() / 1000): RotLevel {
  const days = (now - createdAt) / 86_400;
  if (days < ROT_THRESHOLDS_DAYS[0]) return 0;
  if (days < ROT_THRESHOLDS_DAYS[1]) return 1;
  if (days < ROT_THRESHOLDS_DAYS[2]) return 2;
  return 3;
}

export const ROT_DESCRIPTION: Record<RotLevel, string> = {
  0: 'filed this week',
  1: 'waiting weeks',
  2: 'waiting months',
  3: 'stalled over 90 days',
};

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
