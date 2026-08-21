import { readFileSync } from 'node:fs';
import { defineConfig, fontProviders } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import svelte from '@astrojs/svelte';

/**
 * `bun run build` and `bun run deploy` set ASTRO_BUILD; `astro dev` does not.
 * The Vite cacheDir below already leans on this, and the session cookie needs
 * the same distinction for a different reason — see there.
 */
const built = !!process.env.ASTRO_BUILD;

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    // Keep local D1/KV state on disk between `astro dev` runs so the seeded
    // source catalogue and test reports survive a restart.
    persistState: true,
  }),
  integrations: [
    svelte(),
    /**
     * The two head scripts, injected rather than inlined in the layout.
     *
     * `security.csp` below hashes scripts Astro knows about — bundled chunks,
     * client directives, and whatever is injected at `head-inline` or
     * `before-hydration`. It does not read the rendered HTML, so an `is:inline`
     * script in a layout gets no hash and is blocked by the very policy meant
     * to protect it, in production only. Going through injectScript is what
     * makes each hash follow its file.
     *
     * src/scripts/theme.js resolves the theme before first paint and wires the
     * toggle; src/scripts/session-hint.js corrects the header's sign-in button
     * on prerendered pages. Both have to be in the head and neither needs a
     * bundle.
     */
    {
      name: 'yuzono:inline-scripts',
      hooks: {
        'astro:config:setup': ({ injectScript }) => {
          for (const file of ['theme.js', 'session-hint.js']) {
            injectScript(
              'head-inline',
              readFileSync(new URL(`./src/scripts/${file}`, import.meta.url), 'utf8'),
            );
          }
        },
      },
    },
  ],

  vite: {
    /**
     * `astro build` and `astro dev` both default to node_modules/.vite, so a
     * build run while the dev server is up deletes the pre-bundled deps the dev
     * server is still holding references to — which surfaces as
     * "The file does not exist at .../deps_ssr/..." on the next request.
     * Giving the build its own cache directory keeps them out of each other's
     * way. `bun run build` sets ASTRO_BUILD.
     */
    cacheDir: built ? 'node_modules/.vite-build' : 'node_modules/.vite-dev',
  },

  /**
   * The adapter fills in the Cloudflare KV driver itself (binding SESSION) and
   * carries `cookie` and `ttl` through, so declaring these does not displace
   * it.
   */
  session: {
    /**
     * A week. There was no TTL at all before, which meant a KV session lived
     * for as long as the browser kept the cookie — forever, in practice.
     *
     * That matters because guild membership is the one part of the write gate
     * that cannot be re-checked without a Discord token, and this app stores
     * none (see writeBlockReason in src/lib/auth.ts). Everything else — the
     * ban flag, the account-age threshold — is re-read on every write, so the
     * only thing this bounds is how long a membership that has since been
     * revoked can keep working. A week is short enough that leaving the
     * Discord actually costs you write access, and long enough that a regular
     * visitor is never asked to sign in twice in a week.
     *
     * Astro stamps the expiry when a key is written, so this is a hard cap
     * measured from sign-in rather than a sliding window that browsing keeps
     * renewing. That is the behaviour wanted here: a sliding window would let
     * a stale membership live indefinitely again.
     */
    ttl: 60 * 60 * 24 * 7,
    cookie: {
      /**
       * The `__Host-` prefix is a browser-enforced rule, not a hint: a cookie
       * whose name starts with it is only accepted when it is Secure, has
       * Path=/ and carries no Domain, and it is then locked to this exact
       * host. That is what stops anything on a sibling *.7he.dev host from
       * planting a session id for a visitor to arrive here holding — the other
       * half of the fixation fix in src/pages/auth/callback.ts. Astro's
       * defaults already supply Path=/ and no Domain.
       *
       * Only when built, because the prefix's Secure requirement is absolute
       * and Astro marks the cookie Secure outside dev only. Keeping the prefix
       * in `astro dev` would mean the browser silently dropped the cookie on
       * http://localhost and every request looked signed out.
       *
       * Renaming the cookie invalidates every session issued under the old
       * name. Given what the old name allowed, one forced sign-in is the point
       * rather than a cost.
       */
      name: built ? '__Host-astro-session' : 'astro-session',
    },
  },

  /**
   * Hover, and no prefetchAll.
   *
   * The homepage carries 60 `/report/<id>` links and /sources/ carries 202,
   * all of them server-rendered with no cache headers. Under
   * `prefetchAll` + 'viewport' every one of them was fetched 300ms after it
   * scrolled into view, so a single anonymous visitor who scrolled the
   * homepage cost about 61 Worker invocations and 62 D1 round-trips instead of
   * 1 and 2 — paid for by us, for pages nobody opened. Restoring prefetchAll
   * would restore that bill; it is not the free win it looks like.
   *
   * Prefetch itself stays enabled, so any individual link that genuinely
   * benefits can still opt in with `data-astro-prefetch`.
   */
  prefetch: { defaultStrategy: 'hover' },
  devToolbar: { enabled: false },

  /**
   * Content-Security-Policy, computed at build time.
   *
   * Astro emits a `<meta http-equiv="content-security-policy">` per page and
   * fills in `script-src` and `style-src` with the SHA-256 hash of every inline
   * script and every scoped style it actually rendered. That is the whole
   * reason this is here rather than hand-written into public/_headers: the
   * layout carries inline scripts — the pre-paint theme resolver and the theme
   * toggle — and a hash pasted into a static file goes stale the first time
   * anyone edits one, at which point the site breaks silently in production and
   * nowhere else.
   *
   * `frame-ancestors` deliberately is *not* here: browsers ignore it in a
   * `<meta>` element, so it has to be a real response header. It lives in
   * public/_headers alongside HSTS and the rest, which are also header-only.
   *
   * img-src names Discord's CDN because that is where a signed-in user's
   * avatar comes from; `data:` covers the inline SVG favicon. Everything else
   * is same-origin, which is genuinely true of this site — the fonts are
   * self-hosted through Workers Assets and the source catalogue is fetched from
   * /sources.json on this origin.
   */
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' https://cdn.discordapp.com data:",
        "connect-src 'self'",
        "font-src 'self'",
        // Only ever posts to itself. Blocks an injected form from exfiltrating a
        // report — or a moderator's status change — to somewhere else.
        "form-action 'self'",
        "base-uri 'none'",
        "object-src 'none'",
      ],
    },
  },

  // Self-hosted through Workers Assets, so the font files come from this origin
  // and no runtime request reaches Google — which is the point for this
  // audience, and is what lets the CSP above say `font-src 'self'` and mean it.
  // An earlier version of this comment claimed the site shipped a strict CSP
  // while it shipped no security headers at all; the `security.csp` block above
  // and public/_headers are where that is now actually true.
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'IBM Plex Sans',
      cssVariable: '--font-ui-family',
      weights: [400, 500, 600],
      styles: ['normal'],
      /**
       * `latin` only. `latin-ext` was a 25,868-byte file being fetched at top
       * priority to render nothing: across all 310 source names the single
       * non-ASCII Latin character is the `ü` in "Türk Anime TV", and U+00FC is
       * inside `latin`'s range. The other non-ASCII names are Arabic and
       * Chinese, which neither subset covers and the system fallback draws
       * regardless. Report text can contain anything, and for that the fallback
       * is also what draws it — one unstyled glyph is a better trade than the
       * file on every page.
       */
      subsets: ['latin'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
    {
      provider: fontProviders.google(),
      name: 'IBM Plex Mono',
      cssVariable: '--font-data-family',
      // 500 stays: `.lang` inside the search islands uses it. It is only the
      // preload list in Base.astro that narrows to 400 and 600, which is what
      // the board's numbers are set in.
      weights: [400, 500, 600],
      styles: ['normal'],
      subsets: ['latin'],
      fallbacks: ['ui-monospace', 'monospace'],
    },
  ],
});
