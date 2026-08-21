import { defineMiddleware } from 'astro:middleware';

/**
 * Security headers on server-rendered responses.
 *
 * `public/_headers` cannot do this job alone. On Workers, that file configures
 * headers for **static asset** responses — the 310 prerendered source pages,
 * `/sources.json`, `/_astro/*` — and nothing else. Every on-demand route is the
 * Worker answering, and the asset headers never touch it.
 *
 * Which is exactly backwards from where the risk is. `/report/<id>` carries the
 * moderator controls that change a report's status, and `checkOrigin` cannot
 * defend a framed form because the framed form's origin *is* this site. So the
 * anti-framing headers have to be set here, on the routes that actually have
 * something worth framing. The two files are deliberately kept in step: if you
 * add a header to one, add it to the other, or half the site will have it.
 *
 * The `script-src`/`style-src` half of the CSP is not here. Astro generates it
 * per page from the hashes of the scripts and styles it actually rendered — see
 * `security.csp` in astro.config.mjs — and it arrives as a `<meta>` element.
 * `frame-ancestors` is the one directive browsers ignore inside `<meta>`, hence
 * a second, single-directive `Content-Security-Policy` header. Two policies do
 * not conflict: a browser enforces both, and this one restricts only framing.
 */
const HEADERS: Record<string, string> = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export const onRequest = defineMiddleware(async (_ctx, next) => {
  const res = await next();

  // A Response handed back by the Cache API has an immutable header guard, and
  // the boards do return one (see edgeCachedRender in lib/queries.ts). Writing
  // to it throws, so the cheap path is tried first and the copy is only made
  // when it has to be. `new Response(body, res)` carries the status, the
  // status text and the existing headers across, and passes the stream through
  // rather than buffering it.
  try {
    for (const [name, value] of Object.entries(HEADERS)) res.headers.set(name, value);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    for (const [name, value] of Object.entries(HEADERS)) copy.headers.set(name, value);
    return copy;
  }
});
