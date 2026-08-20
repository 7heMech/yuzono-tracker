import type { StaffLevel } from './db/schema';

/**
 * Level arithmetic, in its own module with no imports of its own: both the
 * session builder and the staff gate need it, and a shared leaf avoids an
 * import cycle between them.
 */
export type Level = 'user' | StaffLevel | 'owner';

const RANK: Record<Level, number> = { user: 0, mod: 1, admin: 2, owner: 3 };

export const atLeast = (level: Level, needed: Level) => RANK[level] >= RANK[needed];

/** The higher of the two grants — see the schema note on why there are two. */
export function combine(
  discordLevel: StaffLevel | null,
  manualLevel: StaffLevel | null,
): 'user' | StaffLevel {
  if (discordLevel === 'admin' || manualLevel === 'admin') return 'admin';
  if (discordLevel === 'mod' || manualLevel === 'mod') return 'mod';
  return 'user';
}

export const LEVEL_LABELS: Record<Level, string> = {
  user: 'Member',
  mod: 'Moderator',
  admin: 'Admin',
  owner: 'Owner',
};
