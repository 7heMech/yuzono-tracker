/**
 * Imports the existing GitHub issue backlog into the tracker.
 *
 * Doubles as the seed for local development and as the real migration path if
 * the tool gets adopted: every open issue becomes a report, and its 👍 reaction
 * count becomes the starting vote weight — reactions are exactly the demand
 * signal this board replaces, so nothing is invented.
 *
 *   gh api -X GET repos/yuzono/anime-extensions/issues -f state=all -f per_page=100 \
 *     --paginate --jq '[...]' > issues_full.json
 *   bun scripts/import-issues.ts issues_full.json > seeds/seed.sql
 */

import { problemKeyFor } from '../src/lib/problems';
import { SOURCES } from '../src/lib/sources';

type Issue = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  createdAt: string;
  closedAt: string | null;
  labels: string[];
  up: number;
  comments: number;
};

const file = process.argv[2];
if (!file) throw new Error('usage: bun scripts/import-issues.ts <issues.json>');
const issues: Issue[] = await Bun.file(file).json();

/* --- source matching ------------------------------------------------------ */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const index = new Map<string, string>();
for (const s of SOURCES) {
  const k = norm(s.name);
  if (!index.has(k)) index.set(k, s.id);
}

/** Titles follow `Name [LANG]: problem`, so the head is before `[` or `:`. */
function headOf(title: string) {
  const cut = title.search(/[[:(]/);
  return (cut === -1 ? title : title.slice(0, cut)).trim();
}

function matchSource(title: string) {
  const head = norm(headOf(title));
  if (!head) return undefined;
  if (index.has(head)) return index.get(head);
  // Sources get suffixes and TLDs in titles ("Miruro.tv", "AnimeWorld India").
  for (const [k, id] of index) {
    if (k.length >= 4 && (head.startsWith(k) || k.startsWith(head))) return id;
  }
  return undefined;
}

/* --- language ------------------------------------------------------------- */
const LANG_TAG: Record<string, string> = {
  en: 'en', es: 'es', pt: 'pt-BR', 'pt-br': 'pt-BR', fr: 'fr', ar: 'ar',
  id: 'id', it: 'it', ita: 'it', de: 'de', ru: 'ru', vi: 'vi', zh: 'zh',
  tr: 'tr', pl: 'pl', hi: 'hi', ko: 'ko', ja: 'ja', sr: 'sr', uk: 'uk',
  multi: 'all', all: 'all',
};

function langOf(title: string, sourceId?: string) {
  const tag = title.match(/\[([A-Za-z-]{2,6})\]/)?.[1]?.toLowerCase();
  if (tag && LANG_TAG[tag]) return LANG_TAG[tag];
  if (sourceId) return SOURCES.find((s) => s.id === sourceId)?.lang ?? 'all';
  return 'all';
}

/* --- kind / cause / stage ------------------------------------------------- */
function kindOf(l: string[]) {
  if (l.includes('Source request')) return 'request';
  if (l.includes('Source is down')) return 'dead';
  if (l.includes('Domain changed')) return 'domain';
  if (l.includes('Feature request')) return 'feature';
  if (l.includes('Meta request')) return 'meta';
  return 'bug';
}

/**
 * Labels are authoritative; the problem text is the fallback. Note this reads
 * the *problem*, never the full title — source names poison the match
 * ("Streamingcommunity: Error 404 (Search)" contains "stream").
 */
function causeOf(l: string[], problemText: string) {
  if (l.includes('Redesign')) return 'redesign';
  if (l.includes('Cloudflare protected')) return 'cloudflare';
  if (l.includes('Geo-blocked')) return 'geo';
  if (l.includes('Domain changed')) return 'domain';
  if (l.includes('Source is down')) return 'down';
  const t = problemText.toLowerCase();
  if (/video|playback|black screen|ffmpeg|server|player|not loading|no stream/.test(t)) return 'extractor';
  if (/domain|url change|moved|new (site|url)/.test(t)) return 'domain';
  if (/redesign|switched to|2\.0|new version|site chang/.test(t)) return 'redesign';
  if (/cloudflare|\bcf\b|captcha|challenge/.test(t)) return 'cloudflare';
  if (/geo|region|country|blocked in/.test(t)) return 'geo';
  if (/40[0-9]|5[0-9][0-9]|not found|down|dead|offline|unavailable/.test(t)) return 'down';
  return 'other';
}

/** Reads the problem text only, for the same reason as causeOf. */
function stageOf(problemText: string, cause: string) {
  const t = problemText.toLowerCase();
  if (/search|latest|popular|\btab\b|browse|filter|library/.test(t)) return 'browse';
  if (/episode|chapter|eplist|season/.test(t)) return 'episodes';
  if (/video|black screen|ffmpeg|server|download|stream|player|playback|subtitle/.test(t)) return 'video';
  // A redesign or a moved domain breaks at the first hop.
  if (cause === 'redesign' || cause === 'domain' || cause === 'down') return 'browse';
  if (cause === 'extractor') return 'video';
  return null;
}

/** Strip the `Name [LANG]:` prefix so the title column holds the problem. */
function problemOf(title: string) {
  const m = title.match(/^[^[:(]{1,48}(?:\[[^\]]+\])?\s*[:\-–]\s*(.+)$/);
  const rest = (m?.[1] ?? title).trim();
  return (rest.charAt(0).toUpperCase() + rest.slice(1)).slice(0, 160);
}

const esc = (v: string) => `'${v.replace(/'/g, "''")}'`;
const nul = (v: string | null | undefined) => (v == null ? 'NULL' : esc(v));
const ts = (d: string) => Math.floor(new Date(d).getTime() / 1000);

/* --- emit ----------------------------------------------------------------- */
const out: string[] = [
  '-- Generated by scripts/import-issues.ts. Vote counts are real 👍 reactions.',
  '--',
  '-- DESTRUCTIVE, AND LOCAL ONLY. The next three DELETEs empty every table this',
  '-- file writes, so running it against the deployed database would erase real',
  '-- reports and real votes. `bun run db:seed` pins --local for that reason;',
  '-- never add --remote to it.',
  'PRAGMA defer_foreign_keys = true;',
  'DELETE FROM notifications; DELETE FROM votes; DELETE FROM reports; DELETE FROM users;',
  `INSERT INTO users (discord_id, username, account_created_at)
     VALUES ('0', 'imported-from-github', 0);`,
];

const stats = { matched: 0, unmatched: 0, byKind: {} as Record<string, number>, votes: 0 };
const seenOpen = new Set<string>();

for (const iss of issues) {
  const kind = kindOf(iss.labels);
  const sourceId = kind === 'request' ? undefined : matchSource(iss.title);
  const lang = langOf(iss.title, sourceId);
  // A request's title is the source's name, so say what's being asked for.
  const problemText =
    kind === 'request' ? `Add ${headOf(iss.title).slice(0, 70) || 'this source'}` : problemOf(iss.title);
  const cause =
    kind === 'bug' || kind === 'domain' || kind === 'dead' ? causeOf(iss.labels, problemText) : null;
  const stage = cause ? stageOf(problemText, cause) : null;
  // The dedupe key the board actually uses, from the one function the migration
  // and this script both answer to — see problemKeyFor in src/lib/problems.ts.
  // A regenerated seed that disagreed with the backfilled production rows would
  // not error; it would just dedupe differently.
  const problemKey = problemKeyFor(kind, stage, cause, !!sourceId);
  const nsfw = iss.labels.includes('18+');

  let status: string;
  if (iss.state === 'closed') status = 'fixed';
  else if (iss.labels.includes('Valid')) status = 'confirmed';
  else status = 'open';

  // Respect the partial unique index: one open row per source, kind *and*
  // problem. Deduping on kind alone collapsed five distinct failures into one,
  // which is what made a source's second broken thing unfileable.
  const dedupeKey = `${sourceId ?? 'req:' + norm(headOf(iss.title))}|${kind}|${problemKey ?? ''}`;
  const isOpen = status !== 'fixed';
  if (isOpen) {
    if (seenOpen.has(dedupeKey)) status = 'duplicate';
    else seenOpen.add(dedupeKey);
  }

  sourceId ? stats.matched++ : stats.unmatched++;
  stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
  const votes = iss.up + 1; // the reporter counts as the first affected person
  stats.votes += votes;

  out.push(
    `INSERT INTO reports (kind, source_id, proposed_name, proposed_url, lang, nsfw, stage, cause, problem, title, status, reporter_id, github_issue, votes, created_at, updated_at, status_changed_at) VALUES (` +
      [
        esc(kind),
        nul(sourceId ?? null),
        // Requests have no source; unmatched bugs still need a display name.
        !sourceId ? esc(headOf(iss.title).slice(0, 80) || 'Unknown') : 'NULL',
        'NULL',
        esc(lang),
        nsfw ? 1 : 0,
        nul(stage),
        nul(cause),
        nul(problemKey),
        esc(problemText),
        esc(status),
        `'0'`,
        iss.number,
        votes,
        ts(iss.createdAt),
        ts(iss.closedAt ?? iss.createdAt),
        iss.closedAt ? ts(iss.closedAt) : 'NULL',
      ].join(', ') +
      ');',
  );
}

console.error(`issues        ${issues.length}`);
console.error(`source match  ${stats.matched} matched / ${stats.unmatched} unmatched`);
console.error(`kinds         ${Object.entries(stats.byKind).map(([k, v]) => `${k}:${v}`).join(' ')}`);
console.error(`votes seeded  ${stats.votes} (from real 👍 reactions + 1 per reporter)`);

console.log(out.join('\n'));
