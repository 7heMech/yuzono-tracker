/**
 * The signed-in hint, resolved before anything paints.
 *
 * `Header.astro` decides whether to mount the user island by reading a plain
 * `signed_in` cookie, which lets the anonymous majority skip a Worker
 * invocation on every view. But the 310 source pages and `/sources/` are built
 * with no request in hand, so that read finds nothing there and those pages
 * ship the guest state — and on the server-rendered pages the island's
 * fallback occupies the corner until its fetch lands. Both used to be
 * corrected after paint, which is exactly a flicker: a signed-in visitor saw
 * "Sign in" on every navigation before the swap.
 *
 * So the correction is CSS, not DOM mutation. This script runs synchronously
 * during head parse — head-inline scripts execute before the body exists,
 * hence before first paint — and only sets an attribute on <html>. The header
 * carries both labels and CSS picks one off the attribute, so the corner is
 * correct in the first frame and nothing is ever repainted.
 *
 * The cookie is not HttpOnly precisely so it can be read here. Nothing is
 * trusted: the attribute only chooses a label and the link goes to /me either
 * way, which authenticates properly and bounces to Discord sign-in when there
 * is no session behind the cookie. A forged or stale cookie buys a wrong
 * label and nothing else. With JavaScript off the attribute never appears,
 * the guest label shows, and /me still routes correctly — the same places a
 * visitor without the cookie ends up.
 *
 * Injected at Astro's `head-inline` stage rather than written inline in the
 * layout, for the same reason as src/scripts/theme.js: the CSP hashes injected
 * scripts and not author inline ones.
 */
if (/(?:^|;\s*)signed_in=1(?:;|$)/.test(document.cookie)) {
  document.documentElement.dataset.signedIn = '';
}
