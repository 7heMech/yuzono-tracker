import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/**
 * Astro 6 removed `Astro.locals.runtime.env`; bindings come from the
 * `cloudflare:workers` module. Any page importing this must be on-demand
 * rendered (`prerender = false`) — there is no D1 at build time.
 */
export const db = () => drizzle(env.DB, { schema });
export { schema };
