# yuzono tracker

A community board for [yuzono/anime-extensions](https://github.com/yuzono/anime-extensions):
which sources are broken, and which ones people want most, ranked by how many
people are actually affected rather than by who shouted loudest.

Unofficial and community-run. Not affiliated with the extension maintainers.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/7heMech/yuzono-tracker)

## Why

Issues arrive as free-form prose on GitHub, duplicates pile up under different
titles, and 👍 reactions are the only demand signal. Measured against the real
backlog (468 issues):

- Source requests are 58% of the open queue. That's the larger half of the
  work, and the half where voting matters most.
- Median open age is 69 days, p90 147. Time-to-close is bimodal: median 3
  days, p90 57. Things get fixed fast or rot.
- 281 of 468 issues have zero comments. Discussion happens in Discord, not
  the tracker, so this has votes instead of comment threads.

One open report per source per problem. Filing something already reported adds
you to it instead of creating a duplicate.

## Stack

Astro 7 (`output: 'server'`) on Cloudflare Workers via `@astrojs/cloudflare`,
Svelte 5 islands, D1 + Drizzle, Astro sessions on Workers KV, Discord OAuth.

Source pages are prerendered, one static page per source at a readable URL like
`/source/animepahe/`, with live report data arriving in a server island. An
anonymous visitor arriving from a search engine gets the page itself from the
edge; the island behind it is one Worker invocation and one indexed D1 read, so
the page is free and only the "is this broken right now?" fragment costs
anything. Earlier revisions of this file claimed the primary was never touched
at all, which was never true. The live status has to come from somewhere.

## Local gotcha: the boards really are cached in dev

The Cloudflare adapter runs `astro dev` under Miniflare, so `caches.default`
exists locally and the hand-written edge cache in `src/lib/queries.ts` is live.
With `persistState: true` its entries are written to
`.wrangler/state/v3/cache` and survive a dev-server restart. Change a board,
or anything a board queries, and the old numbers keep coming back. That is a
cache hit, not a stale module. Stop the server before clearing it. Miniflare
holds the backing SQLite file open, and deleting it underneath a running
server makes every later cache read throw:

```sh
bunx astro dev stop
rm -rf .wrangler/state/v3/cache
bunx astro dev
```

Do that before trusting a board render or a screenshot. Signed-in renders are
never cached, so this only ever affects the anonymous view.

## Setup

Bun only.

```sh
bun install
cp .dev.vars.example .dev.vars     # add the Discord client secret and your user id
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

## Deploying

Either the button above, or Workers → connect a repository in the dashboard.
Both work, and neither needs you to create bindings by hand: the KV namespace
and D1 database in `wrangler.jsonc` are declared without ids, and Wrangler
provisions them on the first deploy. A placeholder id is worse than no id.
Wrangler sends it to the API as-is and the deploy fails with `KV
namespace '...' is not valid`.

The two paths differ in one way worth knowing. The button prompts for the
values in `.dev.vars.example` and writes the generated resource ids back into
your fork. A repo-connected deploy does neither. The ids exist only in the
dashboard, and you supply the three values yourself.

### Set the two secrets

Add `DISCORD_CLIENT_SECRET` and `OWNER_DISCORD_ID` as secrets under Settings →
Variables and Secrets.

As secrets, not plain-text variables. `wrangler deploy` replaces the Worker's
whole `vars` block with the one in `wrangler.jsonc`, so a variable this repo does
not declare gets deleted on the next deploy. Deploys leave secrets alone. That
is why these two are absent from `wrangler.jsonc` rather than sitting there
empty — and why `DISCORD_CLIENT_ID` *is* declared there: it appears in the OAuth
URL every visitor sees, so publishing it costs nothing, and committing it is
what stops each deploy from deleting it.

### Migrations

A fresh D1 has no tables, and the database does not exist until the first
deploy creates it. So migrations are a separate, deliberate step rather than
part of the deploy script:

```sh
bun run db:remote      # after the first deploy, and after any schema change
```

It addresses the database by name because on a repo-connected deploy the
generated id never reaches this config.

### Pin the Bun version

Workers Builds ships Bun 1.2.15 by default and does not read the
`packageManager` field in `package.json`. For Bun the only override is a build
variable. Set it once, in the Worker's Settings → Build → Build Variables and
Secrets:

```
BUN_VERSION = 1.4.0
```

`packageManager` and `engines.bun` are declared in `package.json` all the
same. They pin every other CI and keep local installs honest, and they are the
place to look when the build variable needs bumping.

### Two things Cloudflare cannot do for you

1. **Create the Discord application** at
   [discord.com/developers/applications](https://discord.com/developers/applications)
   → OAuth2, and add `https://<your-worker>.workers.dev/auth/callback` to
   Redirects. It has to match exactly, and a mismatch is the single most
   likely reason a first sign-in fails. No bot, no scopes to configure there.
   This app requests `identify guilds guilds.members.read` per login.
2. **Set `DISCORD_GUILD_ID`** in `wrangler.jsonc` if you are not tracking the
   yuzono server. It ships with theirs.

Then sign in and open `/admin`. Staff roles, the account-age gate and the
Discord announcement webhook are all edited there and stored in D1, so
changing them takes no redeploy. `OWNER_DISCORD_ID` deliberately stays out of
D1. It is what bootstraps the dashboard, so it stays in the environment where
a bad grant can always be undone.

### Deploying by hand instead

```sh
bunx wrangler secret put DISCORD_CLIENT_SECRET
bunx wrangler secret put OWNER_DISCORD_ID
bun run deploy      # build and deploy; D1 and KV are provisioned on the way
bun run db:remote   # then create the tables
```

## Scripts

| Command | What |
|---|---|
| `bun run dev` | Local dev on workerd, with persisted D1/KV |
| `bun run sync:sources` | Regenerate the source catalogue from the extension index |
| `bun scripts/sync-issues.ts` | Push upstream issue state into the tracker (`--dry-run`, `--backfill`) |
| `bun scripts/check-github-sync.ts` | End-to-end check of the sync against a running dev server |
| `bun run db:generate` | Generate a migration from the Drizzle schema |
| `bun run db:local` / `db:remote` | Apply migrations |
| `bun run db:seed` | Load `seeds/seed.sql` into local D1 |
| `bun run types` | Regenerate `worker-configuration.d.ts` from wrangler.jsonc |
| `bun run check` | Typecheck |
| `bun run shot /new /` | Screenshot pages at phone size (390x844, touch, DPR 3) |
| `bun run shot:desktop /` | Same at 1280x900 |
| `bun run deploy` | Build and deploy |

## Reviewing the UI

Mobile is the primary target, so `scripts/shot.ts` drives Chromium over the
DevTools protocol rather than using CLI flags. `--window-size` clamps to a
500px minimum and headless desktop never matches `pointer: coarse`, so flags
cannot review a phone layout at all. The harness sets the real layout
viewport, DPR, touch support and mobile flag, then reports any element wider
than the viewport.

```sh
bun run shot /new /            # writes shot_new_390.png, shot_home_390.png
bun run shot --w 768 --h 1024 /
SHOT_EVAL="innerWidth" bun run shot /   # evaluate an expression in the page
```

Two traps it exists to avoid: Chromium's default profile keeps a persistent
HTTP cache that silently serves a stale page, and `astro dev` does not
reliably pick up scoped style changes in `.astro` files. Restart the dev
server before trusting a screenshot review.

## Permissions this deliberately does not need

Neither Discord guild admin nor GitHub org admin:

- Guild membership comes from the `guilds` scope, staff roles from
  `guilds.members.read`, which returns the signed-in user's own roles. No bot
  in the server. `/admin` takes role ids rather than names because resolving
  a name would require one, and it shows you your own role ids to copy from.
- No GitHub token, and no write access to the extensions repo. The sync reads
  issues as public data and brings state *in*; it never pushes state out.
  Promotion opens a prefilled issue form for a moderator to submit rather than
  calling the API, so `issues: write` is needed nowhere. The one thing this
  costs is that marking a report fixed here cannot close the issue there —
  /review lists those so somebody with access can close them by hand.
- No Cloudflare cron. The Astro adapter owns the Worker entry and exports only
  a `fetch` handler, so a `scheduled` one would mean hand-writing that entry.
  A GitHub Actions schedule in this repo does the same job with nothing to
  break, and works on a repo we do not control.

The app never stores access tokens. Only the resolved flags land in the
session.

## Keeping up with GitHub

Reports carry the number of the issue they correspond to, and the two are kept
in step in both directions that are available without write access upstream.

Two triggers, because they fail differently. `.github/workflows/sync-issues.yml`
reads every upstream issue every half hour and posts the set to `/github/sync`;
it is late but self-correcting. A GitHub webhook on `/github/webhook` is
instant, but a delivery that fails and goes unnoticed is wrong forever. Both go
through the same code, and both are configured from /admin, which generates the
shared secret for each — nothing is asked for at deploy time.

The rule that matters is in `transitionFor` (`src/lib/github.ts`): the sync acts
on a *change* in the upstream state, never on the two states disagreeing. Since
this app cannot close a GitHub issue, "report fixed here, issue still open
there" is the normal resting state after every moderator fix — so a sync that
corrected disagreements would revert every one of them, on every pass, silently.
Comparing what we saw last time against what we see now is what allows a reopen
to be honoured without that. `github_issues` is the table holding that memory;
it is a record rather than a cursor, so losing it costs one round of reopens
rather than stopping the sync.

Issues opened on GitHub rather than here are matched against the source
catalogue. An exact name match with a clear problem is filed automatically;
anything less certain goes to `/review`, which moderators can reach as well as
admins. The matching heuristics are shared with `scripts/import-issues.ts`, so
the live sync and the seed agree about what an issue means.
