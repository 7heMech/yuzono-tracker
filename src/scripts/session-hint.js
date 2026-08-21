/**
 * Corrects the header on prerendered pages for a visitor who is signed in.
 *
 * `Header.astro` decides whether to mount the user island by reading a plain
 * `signed_in` cookie, which lets the anonymous majority skip a Worker
 * invocation on every view. But the 310 source pages and `/sources/` are built
 * with no request in hand, so that read finds nothing there and those pages
 * always ship the Sign in button — telling a signed-in visitor, on the pages
 * they are most likely to arrive on from a search engine, that they are signed
 * out. That is a worse lie than the invocation was a cost.
 *
 * The cookie is not HttpOnly precisely so it can be read here, where a request
 * *is* in hand. Nothing is trusted: this only repoints a link. A forged or
 * stale cookie sends someone to /me, which authenticates properly and bounces
 * them to Discord sign-in if there is no session behind it. The avatar and the
 * username are not reconstructed — they are not in the cookie, and putting
 * anything identifying in a readable cookie to save one link is not a trade
 * worth making.
 *
 * Injected at Astro's `head-inline` stage rather than written inline in the
 * layout, for the same reason as src/scripts/theme.js: the CSP hashes injected
 * scripts and not author inline ones.
 */
document.addEventListener('DOMContentLoaded', () => {
  if (!/(?:^|;\s*)signed_in=1(?:;|$)/.test(document.cookie)) return;

  const link = document.querySelector('a[data-signin-hint]');
  if (!link) return;

  link.href = '/me';
  link.dataset.signedIn = '';
  link.classList.remove('btn-discord');
  const label = link.querySelector('.login-text');
  if (label) label.textContent = 'Your reports';
});
