import type { OpenRequest } from './requests';

/**
 * The open asks, fetched once per page and decoded in one place.
 *
 * Three islands read this now — the board's search box, the request form's
 * twin detection, and the feature form's "already asked for this source" panel
 * — and the payload is positional, so a second copy of the decode is a second
 * chance to disagree with src/pages/requests.json.ts about which slot is which.
 *
 * Client-safe on purpose: nothing here imports the database, so it belongs in
 * the browser bundle. Only `fetch`.
 */

/** A source request: a site that is not in the catalogue yet. */
export interface RequestRow extends OpenRequest {
  id: number;
  name: string;
  /** The bare host, which is both what identifies it and what a row shows. */
  url: string;
  text: null;
  votes: number;
  nsfw: boolean;
}

/** A feature request against a source that already exists. */
export interface FeatureRow extends OpenRequest {
  id: number;
  /** The catalogue id, or '' on the three imported rows that never matched one. */
  sourceId: string;
  name: string;
  url: null;
  /** The ask itself, which is the only thing that identifies one of these. */
  text: string;
  votes: number;
  nsfw: boolean;
}

export interface RequestFeed {
  requests: RequestRow[];
  features: FeatureRow[];
}

/** The positional payload the route emits — see src/pages/requests.json.ts. */
type Payload = {
  r: [number, string, string, number, number?][];
  f: [number, string, string, string, number, number?][];
};

/**
 * Module scope, so two islands on one page share a single request and a second
 * mount after a client-side navigation pays nothing. Expires after a minute so
 * a filing made in another tab still shows up without a reload.
 */
let inflight: Promise<RequestFeed> | null = null;
let fetchedAt = 0;
const MAX_AGE_MS = 60_000;

export function loadRequestFeed(): Promise<RequestFeed> {
  if (inflight && Date.now() - fetchedAt > MAX_AGE_MS) inflight = null;
  if (inflight) return inflight;
  fetchedAt = Date.now();
  const thisFetch = fetch('/requests.json')
    .then((res) => {
      if (!res.ok) throw new Error(`/requests.json answered ${res.status}`);
      return res.json() as Promise<Payload>;
    })
    .then(({ r, f = [] }) => ({
      requests: r.map(([id, name, host, votes, nsfw]) => ({
        id,
        name,
        url: host,
        text: null,
        votes,
        nsfw: nsfw === 1,
      })),
      features: f.map(([id, sourceId, name, ask, votes, nsfw]) => ({
        id,
        sourceId,
        name,
        url: null,
        text: ask,
        votes,
        nsfw: nsfw === 1,
      })),
    }))
    .catch((err) => {
      // A failure must not be cached, or one dropped request leaves every box
      // on the page dead for the rest of its life. Guarded against a newer
      // request that started after this one expired.
      if (inflight === thisFetch) inflight = null;
      throw err;
    });
  inflight = thisFetch;
  return inflight;
}
