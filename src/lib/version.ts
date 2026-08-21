/**
 * Version handling for the "are you actually up to date?" gate.
 *
 * Most breakage reports arrive from stale extensions — the fix already shipped
 * and the reporter never updated. Catching that at report time saves the
 * maintainer the round trip, and the catalogue already tells us the current
 * version of every extension, so the check costs nothing.
 */

/** Split "14.49.1" into [14, 49, 1]. Non-numeric parts become 0. */
function parts(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** Negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * True only when we're confident the reported version is behind. An
 * unparseable or empty input returns false: never block a report on our own
 * inability to read what someone typed.
 */
export function isOutdated(reported: string, latest: string): boolean {
  if (!reported.trim() || !latest.trim()) return false;
  if (!/\d/.test(reported)) return false;
  return compareVersions(reported, latest) < 0;
}

/**
 * True when the input has no digit anywhere, so it cannot be a version.
 * An empty string is not unreadable — it is missing, handled elsewhere.
 */
export function isUnreadableVersion(version: string): boolean {
  return version.trim().length > 0 && !/\d/.test(version);
}

// Compatibility aliases — the name is not the point, the check is.
export const isUnreadable = isUnreadableVersion;
export const isVersionUnreadable = isUnreadableVersion;

/**
 * The two apps this repo targets, plus an escape hatch. "Other" is not a
 * throwaway option: plenty of players can install these extensions and are not
 * forks of either, so picking it asks for the actual name rather than
 * flattening everything else into one useless bucket.
 */
export const APPS = ['Anikku', 'Aniyomi', 'Other'] as const;
export const APP_OTHER = 'Other';
export type AppName = (typeof APPS)[number];
