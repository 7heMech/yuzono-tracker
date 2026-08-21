/**
 * Values that are not in wrangler.jsonc — that file is committed — so
 * `wrangler types` can't see them. Declared here instead, set locally in
 * `.dev.vars`, and in production either by the Deploy to Cloudflare prompt or
 * with `bunx wrangler secret put <NAME>`.
 */
interface Env {
  DISCORD_CLIENT_SECRET: string;
  /** Bootstraps the dashboard: the one authority /admin cannot grant. */
  OWNER_DISCORD_ID?: string;
  /** Optional seed for the webhook that /admin then owns. */
  DISCORD_WEBHOOK_URL?: string;
}

declare namespace Cloudflare {
  interface Env {
    DISCORD_CLIENT_SECRET: string;
    OWNER_DISCORD_ID?: string;
    DISCORD_WEBHOOK_URL?: string;
  }
}
