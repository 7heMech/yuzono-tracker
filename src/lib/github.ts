import { CAUSES, KINDS, STAGES, STATUSES } from './db/schema';
import { problemKeyFor, type ProblemKey } from './problems';
import { SOURCES } from './sources';
import { reportHeadline } from './format';

/**
 * Everything the GitHub sync needs that does not touch the database.
 *
 * Deliberately free of any import that reaches `cloudflare:workers` — schema,
 * problems, sources and format are all leaves — so this module imports cleanly
 * under `bun test` with no `mock.module` stub. The half that reads or writes D1
 * lives in `github-sync.ts` for that reason. Keep it that way: the signature
 * check and the transition table are the two things here that must never be
 * wrong, and they are only cheap to test while this file stays pure.
 */

export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Stage = (typeof STAGES)[number];
export type Cause = (typeof CAUSES)[number];
export type IssueState = 'open' | 'closed';
export type StateReason = 'completed' | 'not_planned' | 'duplicate' | 'reopened' | null;

/** Statuses that mean the report is no longer live demand. */
export const CLOSED_STATUSES = ['fixed', 'wont_fix', 'duplicate'] as const;
export const isClosedStatus = (s: Status) =>
  (CLOSED_STATUSES as readonly string[]).includes(s);

/**
 * One upstream issue, trimmed to what the sync uses. Both entry points build
 * this: the workflow from the REST list response, the webhook from
 * `payload.issue`. Sharing the shape is what lets both paths run the same
 * mapping code, so the two can never disagree about what an issue means.
 */
export interface IssueSnapshot {
  number: number;
  title: string;
  state: IssueState;
  stateReason: StateReason;
  body: string | null;
  labels: string[];
  createdAt: number;
  updatedAt: number;
  /** 👍 count, used to seed votes on adoption as the original import did. */
  reactions: number;
}

/* --- signatures ----------------------------------------------------------- */

/**
 * HMAC-SHA256 over the raw body, in GitHub's `sha256=<hex>` framing.
 *
 * There was no crypto anywhere in this codebase before this, so a note on the
 * two things that are easy to get wrong. First, the *raw* body has to be
 * hashed: re-serialising the parsed JSON changes bytes GitHub signed, so the
 * caller reads `await request.text()` once and passes that string here rather
 * than a parsed object. Second, `crypto.subtle.verify` is used instead of
 * comparing hex strings, because it compares in constant time by construction
 * — a hand-written `===` on the digest leaks the position of the first wrong
 * byte, which is exactly the signal a forger needs.
 */
export async function verifySignature(
  secret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  if (!secret || !header) return false;
  const hex = signatureHex(header);
  if (!hex) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, hexToBytes(hex), new TextEncoder().encode(rawBody));
}

/** Signs a body the same way, for the workflow side. */
export async function sign(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

/**
 * Pulls the hex out of a `sha256=…` header, or null if it is not shaped like
 * one. Checked before the secret is read, so a request with a malformed or
 * missing signature is refused without costing a D1 round trip — which is what
 * stops an unauthenticated public route from being a free database query.
 */
export function signatureHex(header: string | null): string | null {
  if (!header) return null;
  const m = /^sha256=([0-9a-f]{64})$/.exec(header.trim().toLowerCase());
  return m ? m[1] : null;
}

const hexToBytes = (hex: string) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/* --- state mapping -------------------------------------------------------- */

/**
 * What a *closure* means here. `state_reason` is in the payload and is far more
 * reliable than reading labels for it: it is a closed set GitHub maintains,
 * whereas labels are free-form and get renamed.
 */
export function closedStatusFor(reason: StateReason): Status {
  switch (reason) {
    case 'not_planned':
      return 'wont_fix';
    case 'duplicate':
      return 'duplicate';
    // `completed`, and anything unrecognised. An issue closed with no reason at
    // all is overwhelmingly a fix in this repo's history.
    default:
      return 'fixed';
  }
}

/**
 * The one rule this whole feature turns on: **act on transitions, never on
 * disagreement.**
 *
 * We have no write access upstream, so the tracker can never close a GitHub
 * issue. "Report is fixed here, issue still open there" is therefore the normal
 * resting state after every moderator fix, not an anomaly to correct. A sync
 * that reopened whenever the two disagreed would undo every moderator decision
 * on every pass, forever — silently, and only visibly weeks later as staff
 * wondering why their work keeps reverting.
 *
 * Comparing the *previously observed* upstream state against the current one
 * avoids that without giving up reopens. Returns the status to apply, or null
 * for "nothing happened upstream, leave it alone".
 *
 * `lastSeen` is null on first sight, where a closure still applies but a reopen
 * is never inferred: with no prior observation there is no evidence of one.
 */
export function transitionFor(
  lastSeen: IssueState | null,
  current: IssueState,
  reason: StateReason,
): Status | null {
  if (current === 'closed' && lastSeen !== 'closed') return closedStatusFor(reason);
  // Reopened. `confirmed` rather than `open`: an issue someone bothered to
  // reopen is a problem known to be real, which is what that status means.
  if (current === 'open' && lastSeen === 'closed') return 'confirmed';
  return null;
}

/** For the mismatch list: we say done, upstream still says open. */
export const isMismatch = (trackerStatus: Status, current: IssueState) =>
  current === 'open' && isClosedStatus(trackerStatus);

/* --- matching ------------------------------------------------------------- */

/**
 * Source, language, kind, cause and stage inference, moved here from
 * scripts/import-issues.ts so the live sync and the one-off importer answer to
 * one implementation. The script now imports these. That matters more than it
 * looks: these heuristics were tuned against the real 468-issue backlog, and a
 * second copy in the Worker would drift from the seed and dedupe differently.
 */

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Titles follow `Name [LANG]: problem`, so the head is before `[` or `:`. */
export function headOf(title: string) {
  const cut = title.search(/[[:(]/);
  return (cut === -1 ? title : title.slice(0, cut)).trim();
}

const nameIndex = (() => {
  const index = new Map<string, string>();
  for (const s of SOURCES) {
    const k = norm(s.name);
    if (!index.has(k)) index.set(k, s.id);
  }
  return index;
})();

export type MatchHow = 'exact' | 'prefix' | 'none';

/**
 * How confidently a title names a catalogue source. The distinction is the
 * whole point: an exact normalised hit is safe to act on unattended, while the
 * prefix fallback — which exists because titles carry TLDs and suffixes
 * ("Miruro.tv", "AnimeWorld India") — guesses often enough that it belongs in
 * front of a moderator instead.
 */
export function matchSourceHow(title: string): { sourceId?: string; how: MatchHow } {
  const head = norm(headOf(title));
  if (!head) return { how: 'none' };
  const exact = nameIndex.get(head);
  if (exact) return { sourceId: exact, how: 'exact' };
  for (const [k, id] of nameIndex) {
    if (k.length >= 4 && (head.startsWith(k) || k.startsWith(head))) {
      return { sourceId: id, how: 'prefix' };
    }
  }
  return { how: 'none' };
}

/** Kept for the importer, which only ever wanted the id. */
export const matchSource = (title: string) => matchSourceHow(title).sourceId;

const LANG_TAG: Record<string, string> = {
  en: 'en', es: 'es', pt: 'pt-BR', 'pt-br': 'pt-BR', fr: 'fr', ar: 'ar',
  id: 'id', it: 'it', ita: 'it', de: 'de', ru: 'ru', vi: 'vi', zh: 'zh',
  tr: 'tr', pl: 'pl', hi: 'hi', ko: 'ko', ja: 'ja', sr: 'sr', uk: 'uk',
  multi: 'all', all: 'all',
};

export function langOf(title: string, sourceId?: string) {
  const tag = title.match(/\[([A-Za-z-]{2,6})\]/)?.[1]?.toLowerCase();
  if (tag && LANG_TAG[tag]) return LANG_TAG[tag];
  if (sourceId) return SOURCES.find((s) => s.id === sourceId)?.lang ?? 'all';
  return 'all';
}

export function kindOf(l: string[]): Kind {
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
export function causeOf(l: string[], problemText: string): Cause {
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
export function stageOf(problemText: string, cause: Cause): Stage | null {
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
export function problemOf(title: string) {
  const m = title.match(/^[^[:(]{1,48}(?:\[[^\]]+\])?\s*[:\-–]\s*(.+)$/);
  const rest = (m?.[1] ?? title).trim();
  return (rest.charAt(0).toUpperCase() + rest.slice(1)).slice(0, 160);
}

export interface Classified {
  how: MatchHow;
  sourceId: string | null;
  /** Display name when nothing matched, so an unmatched row still reads. */
  proposedName: string | null;
  kind: Kind;
  lang: string;
  nsfw: boolean;
  stage: Stage | null;
  cause: Cause | null;
  problem: ProblemKey | null;
  title: string;
  /**
   * Whether this is confident enough to act on unattended. False sends it to
   * /review. A prefix-only source match or a problem key that lands on `other`
   * are both guesses, and a report filed against the wrong source costs more to
   * unpick than it costs a moderator to confirm.
   */
  confident: boolean;
  /** Plain-words explanation for /review. Never a score or a badge. */
  why: string;
}

export function classifyIssue(issue: IssueSnapshot): Classified {
  const kind = kindOf(issue.labels);
  const m = kind === 'request' ? { how: 'none' as MatchHow } : matchSourceHow(issue.title);
  const sourceId = m.sourceId ?? null;
  const lang = langOf(issue.title, m.sourceId);
  const title =
    kind === 'request'
      ? `Add ${headOf(issue.title).slice(0, 70) || 'this source'}`
      : problemOf(issue.title);
  const cause =
    kind === 'bug' || kind === 'domain' || kind === 'dead' ? causeOf(issue.labels, title) : null;
  const stage = cause ? stageOf(title, cause) : null;
  const problem = problemKeyFor(kind, stage, cause, !!sourceId);
  const source = sourceId ? SOURCES.find((s) => s.id === sourceId) : undefined;

  const cleanProblem = problem !== null && problem !== 'other';
  const confident = m.how === 'exact' && cleanProblem;
  const why =
    m.how === 'none'
      ? `No catalogue source matches "${headOf(issue.title) || issue.title}".`
      : m.how === 'prefix'
        ? `Matched ${source?.name ?? 'a source'} by name prefix, not exactly.`
        : cleanProblem
          ? `Matched ${source?.name ?? 'a source'} exactly.`
          : `Matched ${source?.name ?? 'a source'} exactly, but the problem is unclear from the labels.`;

  return {
    how: m.how,
    sourceId,
    proposedName: sourceId ? null : headOf(issue.title).slice(0, 80) || 'Unknown',
    kind,
    lang,
    // The catalogue owns the 18+ flag for a known source, exactly as filing
    // does; the label is only trusted when there is no catalogue entry.
    nsfw: source ? source.nsfw : issue.labels.includes('18+'),
    stage,
    cause,
    problem,
    title,
    confident,
    why,
  };
}

/* --- promotion ------------------------------------------------------------ */

/**
 * The upstream issue-form template per kind. These filenames are already
 * recorded against the enum in db/schema.ts.
 */
const TEMPLATES: Record<Kind, string> = {
  bug: '01_report_issue.yml',
  request: '02_request_source.yml',
  domain: '03_report_url_change.yml',
  dead: '04_report_dead_source.yml',
  feature: '05_request_feature.yml',
  meta: '06_request_meta.yml',
  removal: '07_request_removal.yml',
};

export interface PromotableReport {
  id: number;
  kind: Kind;
  title: string;
  lang: string;
  sourceId: string | null;
  proposedName: string | null;
  stage: Stage | null;
  cause: Cause | null;
}

/**
 * The title we would file upstream, in the `Name [LANG]: problem` shape the
 * repo's existing 468 issues use. Also the fallback used to recognise the
 * created issue when it comes back to us, so it has to be deterministic.
 */
export function promoteTitle(r: PromotableReport): string {
  const name = r.sourceId
    ? (SOURCES.find((s) => s.id === r.sourceId)?.name ?? r.proposedName ?? 'Unknown')
    : (r.proposedName ?? 'Unknown');
  const tag = r.lang && r.lang !== 'all' ? ` [${r.lang.toUpperCase()}]` : '';
  return `${name}${tag}: ${reportHeadline(r)}`;
}

/**
 * A prefilled issue-form URL rather than `POST /issues`, because this install
 * holds no GitHub token and needs no `issues: write` anywhere. The moderator
 * submits the form; the next sync pass recognises the new issue and links it,
 * so nobody ever pastes an issue number back by hand.
 *
 * Unknown query parameters are ignored by GitHub's issue forms, so the `body`
 * hint below is safe to send whether or not the template happens to expose a
 * matching field id. It carries the tracker backlink, which is the strong way
 * to recognise the issue later; `promoteTitle` is the fallback when it does not
 * survive into the issue body.
 */
export function promoteUrl(r: PromotableReport, repo: string, origin: string): string {
  const u = new URL(`https://github.com/${repo}/issues/new`);
  u.searchParams.set('template', TEMPLATES[r.kind]);
  u.searchParams.set('title', promoteTitle(r));
  u.searchParams.set('body', `Tracked at ${origin}/report/${r.id}`);
  return u.toString();
}

/** The backlink promoteUrl plants, read back out of an issue body. */
export function reportIdFromBody(body: string | null): number | null {
  if (!body) return null;
  const m = /\/report\/(\d{1,9})\b/.exec(body);
  return m ? Number(m[1]) : null;
}
