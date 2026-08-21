import type { APIRoute } from 'astro';
import { getSourceByRef, sourcePath } from '../../lib/sources';

/**
 * Keeps old `/source/<snowflake>` links alive.
 *
 * The 310 source pages moved from the numeric id to a slug, and those numeric
 * URLs are not disposable: every report row in the database names its source by
 * id, and any tab open across the deploy is holding one. So this answers the old
 * shape with a 301 to the new one rather than a 404.
 *
 * Why a route and not `redirects` in astro.config.mjs: that config takes a
 * literal map, so it would mean 310 hand-written entries becoming 310 routes in
 * the manifest, and a list that goes stale the moment a source is renamed or
 * `sync:sources` adds one. This resolves through the id map src/lib/sources.ts
 * already builds, so it cannot drift out of step with the slugs.
 *
 * It does not shadow the 310 prerendered pages, and that was checked rather
 * than assumed. Astro sorts routes with `routeComparator`
 * (astro/dist/core/routing/priority.js): for two routes whose segments are
 * otherwise equal it puts the one *without* a spread part first. Run against
 * the real comparator and the real compiled patterns, `/source/[slug]` sorts
 * ahead of `/source/[...ref]` and `/source/animepahe/` matches `[slug]`. Both
 * ends behave:
 *
 *   - In the Worker a prerendered page is a static file, so Workers Assets
 *     answers it and the Worker is not invoked at all. A path with no file
 *     behind it does reach the Worker, and `matchRequest` then walks past the
 *     prerendered match to the first on-demand one — this route.
 *   - In `astro dev` there are no files, so `[slug]` is tried first and its
 *     `getProps` throws NoMatchingStaticPathFound for an id that is not in
 *     getStaticPaths; the dev router catches exactly that error and continues
 *     to the next match. So a numeric link redirects locally too, and is not
 *     a production-only code path nobody ever exercises.
 *
 * `prerender = false` is load-bearing. Prerendering this would try to build a
 * file for a spread route with no `getStaticPaths`, and there would be nothing
 * on demand left to catch an unknown ref.
 */
export const prerender = false;

export const GET: APIRoute = (ctx) => {
  const ref = ctx.params.ref;

  // `/source` and `/source/` are a hand-truncated URL, not a source. Sending
  // them to the catalogue is what the person doing the truncating wanted.
  if (!ref) return ctx.redirect('/sources/', 301);

  const source = getSourceByRef(ref);
  if (!source) return ctx.rewrite('/404');

  /**
   * A canonical slug must never be redirected, or it redirects to itself
   * forever. Reaching here with `ref === source.slug` means the prerendered
   * file did not get served — an assets misconfiguration, not a stale link —
   * and a loop would turn that into an unrecoverable page instead of a
   * diagnosable one.
   */
  if (ref === source.slug) return ctx.rewrite('/404');

  return ctx.redirect(sourcePath(source), 301);
};
