/**
 * The entire report taxonomy, expressed as things a person would actually say.
 *
 * Six choices keeps the decision inside Hick's-law territory, and each one is a
 * submit button — so filing is: find your source, tap what's wrong. Two taps.
 * Everything the schema needs (kind, stage, cause) is derived from the choice
 * rather than asked about.
 */
export const PROBLEMS = [
  {
    key: 'no-video',
    label: "Video won't play",
    hint: 'Episode opens but nothing plays, or every server fails',
    kind: 'bug',
    stage: 'video',
    cause: 'extractor',
  },
  {
    key: 'no-episodes',
    label: 'No episodes listed',
    hint: 'The anime page loads but the episode list is empty',
    kind: 'bug',
    stage: 'episodes',
    cause: 'other',
  },
  {
    key: 'no-browse',
    label: 'Search or browse is broken',
    hint: 'Popular, Latest or Search returns nothing or errors',
    kind: 'bug',
    stage: 'browse',
    cause: 'other',
  },
  {
    key: 'moved',
    label: 'Site moved to a new address',
    hint: 'The old domain redirects or is parked somewhere else',
    kind: 'domain',
    stage: 'browse',
    cause: 'domain',
  },
  {
    key: 'blocked',
    label: 'Blocked before it loads',
    hint: 'Cloudflare check, captcha, or blocked in my country',
    kind: 'bug',
    stage: 'browse',
    cause: 'cloudflare',
  },
  {
    key: 'gone',
    label: 'The site is gone for good',
    hint: 'Shut down, not just down for a day',
    kind: 'dead',
    stage: 'browse',
    cause: 'down',
  },
] as const;

export type ProblemKey = (typeof PROBLEMS)[number]['key'];
export const problemByKey = (k: string) => PROBLEMS.find((p) => p.key === k);
