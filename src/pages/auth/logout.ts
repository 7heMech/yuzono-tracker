import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  ctx.session?.destroy();
  // Cleared alongside the session, or the header would keep paying for a user
  // island that has nobody to render. It is only a hint, so a stale one is
  // harmless — but a wrong hint on every page of a signed-out browser is the
  // exact cost this cookie exists to avoid.
  ctx.cookies.delete('signed_in', { path: '/' });
  return ctx.redirect('/', 302);
};
