/**
 * Where a request may be sent back to after a detour.
 *
 * `?next=` and the `Referer` header are both attacker-supplied, and both were
 * being handed to `redirect()` unchecked — so a link like
 * `/auth/discord?next=https://evil.example` would have bounced someone to
 * another site *after* a successful Discord sign-in, which is exactly the
 * moment a phishing page wants them. Only same-origin paths survive.
 */
export function safeReturnTo(
  raw: string | null | undefined,
  origin: string,
  fallback = '/',
): string {
  if (!raw) return fallback;
  try {
    // Resolving against our own origin is what catches the awkward cases:
    // `//evil.example` becomes an absolute URL elsewhere, and `javascript:`
    // never parses to a matching origin.
    const url = new URL(raw, origin);
    if (url.origin !== origin) return fallback;
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}
