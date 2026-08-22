/**
 * Address comparison, kept apart from lib/writes.ts because a browser needs it.
 *
 * These two functions decide whether two people have asked for the same site,
 * and that decision is now made twice: once on the server when a request is
 * filed, and once in RequestFinder.svelte while it is still being typed. The
 * rest of lib/writes.ts reaches for D1 at module scope through
 * `cloudflare:workers`, which no client bundle can import — so the pure half
 * lives here and writes.ts re-exports it, leaving every existing call site
 * (and its tests) untouched.
 */

/**
 * The comparable host of an address: lowercased, no leading `www.`, no path.
 *
 * Requests are deduplicated on this and nothing else. The previous test was
 * `stored.includes(host)`, which is wrong twice over: innocently, because
 * `'https://anime.com'.includes('e.com')` is true, so a request for e.com was
 * swallowed by an unrelated one; and deliberately, because a stored address of
 * `https://evil.example/animefire.plus/hianime.to` contains the host of every
 * site someone might later ask for, and would have absorbed each of those
 * requests — and their votes — into itself. Only equality of the host is safe,
 * and it must be parsed back out because normaliseUrl keeps the path.
 */
export function hostOf(url: string): string | null {
  const v = url.trim();
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.host.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** True only when both addresses parse and name the same host. */
export function sameHost(a: string, b: string): boolean {
  const x = hostOf(a);
  return x !== null && x === hostOf(b);
}
