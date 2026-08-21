/**
 * The theme, resolved before paint and toggled after it.
 *
 * Injected at Astro's `head-inline` stage rather than written as an `is:inline`
 * script in the layout, and that is not a style preference. `security.csp` in
 * astro.config.mjs emits a per-page `<meta http-equiv="content-security-policy">`
 * whose `script-src` lists the SHA-256 hash of every script Astro knows about —
 * bundled chunks, client directives, and scripts injected at this stage or at
 * `before-hydration`. It does **not** walk the rendered HTML, so an `is:inline`
 * script gets no hash and the CSP blocks it. That failure appears only in a
 * production build, where the meta tag exists; `astro dev` and the typecheck
 * both stay silent about it. Injecting the file is what keeps the hash correct
 * automatically, however often this changes.
 *
 * It has to run in the head, synchronously, because the whole point is that an
 * explicit choice never flashes the system theme: `light-dark()` in the tokens
 * resolves off `color-scheme`, which `data-theme` sets, and that has to be set
 * before the first paint rather than after a module has been fetched.
 *
 * Two states, not three. "Auto" is the starting state, not a destination — the
 * system preference is resolved to a real theme here, so the button never has
 * to show an icon for "whatever your OS says". Until someone actually picks,
 * the media listener keeps following the system live; once `theme` is in
 * localStorage it is a decision and the listener stands down. The check lives
 * inside the listener rather than being read once at startup, because a version
 * that read it once stayed attached after a toggle and let a later system
 * change silently override the explicit choice.
 */
const root = document.documentElement;

const wording = (theme) =>
  theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

function apply(theme) {
  root.dataset.theme = theme;
  // The label follows the icon: both say what the click *does*, not what the
  // theme currently is. The button is rendered server-side in Header.astro and
  // does not exist yet on this first pass, hence the null guard and the
  // second call once the DOM is up.
  const button = document.getElementById('theme-toggle');
  if (button) {
    button.setAttribute('aria-label', wording(theme));
    button.title = wording(theme);
  }
}

const stored = localStorage.getItem('theme');
apply(
  stored === 'light' || stored === 'dark'
    ? stored
    : matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark',
);

document.addEventListener('DOMContentLoaded', () => apply(root.dataset.theme));
// View Transitions keeps the document alive across navigations and swaps the
// body/head rather than doing a full reload. DOMContentLoaded only fires once,
// so the button label and data-theme have to be re-applied on each swap.
document.addEventListener('astro:page-load', () => apply(root.dataset.theme));
document.addEventListener('astro:after-swap', () => {
  // `astro:page-load` fires after hydration; `astro:after-swap` fires earlier,
  // before paint of the new document. Re-applying here prevents a flash where
  // the new header's theme icons are briefly both visible.
  const current = root.dataset.theme;
  if (current) apply(current);
});

// Delegated from the document rather than bound to the button, because this
// script runs in the head and the button is further down the page.
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest('#theme-toggle')) return;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  apply(next);
});

matchMedia('(prefers-color-scheme: light)').addEventListener('change', (event) => {
  if (!localStorage.getItem('theme')) apply(event.matches ? 'light' : 'dark');
});
