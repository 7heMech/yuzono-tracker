# yuzono tracker

A community board for [yuzono/anime-extensions](https://github.com/yuzono/anime-extensions):
which sources are broken, and which ones people want most — ranked by how many
people are actually affected rather than by who shouted loudest.

Unofficial and community-run. Not affiliated with the extension maintainers.

## Why

Issues arrive as free-form prose on GitHub, duplicates pile up under different
titles, and 👍 reactions are the only demand signal. Measured against the real
backlog (468 issues):

- **Source requests are 58% of the open queue** — the larger half of the work,
  and the half where voting matters most.
- **Median open age is 69 days**, p90 147. Time-to-close is bimodal: median
  3 days, p90 57. Things get fixed fast or rot.
- **281 of 468 issues have zero comments.** Discussion happens in Discord, not
  the tracker — so this has votes, not comment threads.

One open report per source per problem. Filing something already reported adds
you to it instead of creating a duplicate.

## Stack

Astro 7 (`output: 'server'`) on Cloudflare Workers via `@astrojs/cloudflare`,
Svelte 5 islands, D1 + Drizzle, Astro sessions on Workers KV, Discord OAuth.

Source pages are prerendered — one static page per source, with live report data
arriving in a server island — so an anonymous visitor arriving from a search
engine gets edge HTML and never touches the D1 primary.

## Setup

Bun only.

```sh
bun install
cp .dev.vars.example .dev.vars     # add Discord client id + secret
bun run sync:sources               # pull the extension index → src/data/sources.json
bunx wrangler d1 create yuzono-tracker   # paste database_id into wrangler.jsonc
bun run db:local                   # apply migrations to local D1
bun run dev
```

### Seeding real data (optional)

Imports the existing GitHub backlog, using each issue's 👍 count as the starting
vote weight:

```sh
gh api -X GET repos/yuzono/anime-extensions/issues -f state=all -f per_page=100 \
  --paginate --jq '[.[] | select(.pull_request == null) | {number, title, state,
    createdAt: .created_at, closedAt: .closed_at, labels: [.labels[].name],
    up: .reactions["+1"], reactions: .reactions.total_count, comments: .comments}]' \
  | jq -s add > issues.json

bun scripts/import-issues.ts issues.json > seeds/seed.sql
bun run db:seed
```

## Scripts

| Command | What |
|---|---|
| `bun run dev` | Local dev on workerd, with persisted D1/KV |
| `bun run sync:sources` | Regenerate the source catalogue from the extension index |
| `bun run db:generate` | Generate a migration from the Drizzle schema |
| `bun run db:local` / `db:remote` | Apply migrations |
| `bun run db:seed` | Load `seeds/seed.sql` into local D1 |
| `bun run types` | Regenerate `worker-configuration.d.ts` from wrangler.jsonc |
| `bun run check` | Typecheck |
| `bun run deploy` | Build and deploy |

## Permissions this deliberately does not need

Neither Discord guild admin nor GitHub org admin:

- **Guild membership** comes from the `guilds` scope; **maintainer roles** from
  `guilds.members.read`, which returns the signed-in user's own roles. No bot in
  the server. Role *ids* go in `MAINTAINER_ROLE_IDS` because resolving role
  names would require one.
- **GitHub promotion** builds a prefilled issue-form URL against the existing
  templates rather than opening issues via the API, so it needs no token.
- Issue state syncs back by polling the public API on a cron, not a webhook.

Access tokens are never stored — only the resolved flags land in the session.
