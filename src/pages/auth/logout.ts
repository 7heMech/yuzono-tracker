import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  await ctx.session?.destroy();
  return ctx.redirect('/', 302);
};
