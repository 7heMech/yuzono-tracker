/**
 * Secrets are not declared in wrangler.jsonc — that file is committed — so
 * `wrangler types` can't see them. Declared here instead, and set locally in
 * `.dev.vars` / in production with `bunx wrangler secret put <NAME>`.
 */
interface Env {
  DISCORD_CLIENT_SECRET: string;
  /** Optional: lifts the GitHub issue-state poll from 60 to 5000 req/h. */
  GITHUB_TOKEN?: string;
  /** Optional: channel webhook for "fixed" announcements. */
  DISCORD_WEBHOOK_URL?: string;
}

declare namespace Cloudflare {
  interface Env {
    DISCORD_CLIENT_SECRET: string;
    GITHUB_TOKEN?: string;
    DISCORD_WEBHOOK_URL?: string;
  }
}
