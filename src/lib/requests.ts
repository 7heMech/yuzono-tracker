import { hostOf, sameHost } from './host';

/**
 * The one rule for "somebody already asked for this site", shared by the
 * server that acts on it and the form that warns about it first.
 *
 * /request has always deduplicated on submit: file a site someone else has
 * already asked for and you are added to their request instead of making a
 * second one. That is the right outcome and it is kept — but it only ever
 * happened *after* the form was sent, so from the requester's side it looked
 * like their request had been swallowed. These helpers let RequestFinder.svelte
 * say it while they are still typing, without inventing a second, subtly
 * different notion of "the same site" in the browser.
 *
 * Nothing here touches the database or the DOM, so it runs in the Worker and in
 * the client bundle, and is testable on its own — see tests/lib/requests.ts.
 */

/** The two columns the rule reads, whatever else the caller's row carries. */
export interface OpenRequest {
  id: number;
  /** `proposed_name`, or the display name in the client payload. */
  name: string | null;
  /** `proposed_url`, or the bare host in the client payload. */
  url: string | null;
}

/**
 * A name reduced to what a person meant by it: case, spacing and punctuation
 * removed. "Anime Fire", "animefire" and "AnimeFire!" are one site, and people
 * reach the same site by all three.
 */
export const normName = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/**
 * The open request this one would duplicate, if any.
 *
 * Same host *or* the same normalised name, because the point is that filing
 * again upvotes rather than duplicating, and people reach the same site by
 * different URLs. Host equality only — never containment; see hostOf.
 */
export function duplicateOf<T extends OpenRequest>(
  open: readonly T[],
  name: string,
  url: string,
): T | undefined {
  const n = normName(name);
  return open.find(
    (r) =>
      (!!r.url && !!url.trim() && sameHost(r.url, url)) ||
      (!!r.name && n.length > 0 && normName(r.name) === n),
  );
}

/**
 * Open requests worth showing while someone types, nearest first.
 *
 * Both fields are searched from both fields: a name query is tried against
 * stored names *and* stored hosts (typing "animefire" finds a request stored
 * under a different display name), and a typed address is tried the same way.
 * Prefix matches rank above substring matches, as in the source finder.
 *
 * Two characters is the floor. Below that every request in the table matches
 * and the panel is noise.
 */
export function suggestRequests<T extends OpenRequest>(
  open: readonly T[],
  name: string,
  url: string,
  limit = 6,
): T[] {
  const needles = [normName(name), normName(hostOf(url) ?? '')].filter((n) => n.length >= 2);
  if (!needles.length) return [];

  const starts: T[] = [];
  const contains: T[] = [];
  for (const r of open) {
    const fields = [normName(r.name ?? ''), normName(r.url ?? '')];
    if (needles.some((n) => fields.some((f) => f.startsWith(n)))) starts.push(r);
    else if (needles.some((n) => fields.some((f) => f.includes(n)))) contains.push(r);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
