import { CAUSES, KINDS, STAGES, STATUSES } from './db/schema';
import { normaliseUrl, problemKeyFor, type ProblemKey } from './problems';
import { langLabel, SOURCES } from './sources';
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

/* The three shapes a request title takes around the name of the site.
   Applied in order — filler, ask, filler — and once each, never in a loop:
   stripping generic words repeatedly would eat real names ("The Anime Place"
   becoming "Anime Place"). "new" only counts as filler in front of a filler
   noun for the same reason, so a site actually called "New Anime Site" keeps
   its name while a title of "New Source" is recognised as saying nothing.

   Each pattern has to end at whitespace, a separator or the end of the string.
   Without that, "Request to add New Source/extension for movie" had "New
   Source" taken out of the middle of a name and became "/extension for
   movie" — the slash is a word boundary, but it is not the end of a word. */
const FILLER =
  /^(?:new\s+)?(?:sources?|extensions?|sites?|websites?)(?:\s+request)?(?:\s+for)?(?=$|[\s:,\-–])[\s:,\-–]*/i;
const ASK =
  /^(?:(?:please|pls|plz|kindly)\s+)?(?:requests?(?:ing)?(?:\s+to\s+add)?|add(?:ing)?)(?=$|[\s:,\-–])[\s:,\-–]*/i;
const THANKS = /[\s,]*\b(?:please|pls|plz|thanks|thank\s+you|thx)\b[.!\s]*$/i;

/**
 * The site a source request is actually asking for, out of its issue title.
 *
 * Requests are titled by hand, so a good few of the 198 say the ask as well as
 * the name: "Add PirateXplay", "Source request for movie box", "Add LaMovie
 * please". Both the row's name and its headline are built from this string, and
 * the headline prefixes "Add" — so those rows read "Add PirateXplay · Add Add
 * PirateXplay", with the word said twice in one line and the site named once.
 *
 * Returns null for anything it cannot improve: a title that was already just a
 * name ("AnimeFire"), and a title with nothing but the ask in it ("Source
 * request", "New Source", "Adding source request"). Neither is a failure, and
 * both mean the same thing to a caller — keep the raw title. The issue in the
 * second case genuinely does not name a site, and "Unknown" is a worse thing to
 * print than the words somebody actually wrote.
 */
export function requestedName(head: string): string | null {
  let v = head.trim().replace(/\s+/g, ' ');
  v = v.replace(FILLER, '');
  v = v.replace(ASK, '');
  v = v.replace(FILLER, '');
  v = v.replace(THANKS, '');
  v = v.replace(/^[\s:,\-–]+|[\s:,\-–]+$/g, '');
  // Nothing recognisable as a name: no letters or digits, or a single stray
  // character left behind by the stripping above.
  if (norm(v).length < 2) return null;
  return v === head.trim().replace(/\s+/g, ' ') ? null : v;
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
  /** The site a source request names, read out of the issue body. Requests only. */
  proposedUrl: string | null;
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

/**
 * Whether a report is 18+, given the source it matched and the issue's labels.
 *
 * The catalogue owns the answer for a known source, exactly as filing through
 * /new does: the flag comes from the upstream extension index, which is the
 * same signal the apps themselves use to hide a source, and a GitHub label is
 * neither maintained nor authoritative next to it. The label is trusted only
 * when there is no catalogue entry to ask — a request for a site that does not
 * exist yet, or an adopted issue whose source could not be matched.
 *
 * A note on what the flag actually means, because it is coarser than it looks.
 * Upstream sets it on 108 of 310 sources, including Miruro.tv, KissKH, Anikage
 * and Animenosub, which are not adult sites but do carry some adult content.
 * The extension repos are preparing a three-state SAFE / MIXED / NSFW
 * classification in which those land in MIXED, but neither the library nor the
 * apps support it yet, so a boolean is all there is to read. When that lands,
 * this function is the seam: it is the one place that decides, and the column
 * behind it can widen without touching any caller.
 *
 * Exported and shared rather than inlined because two callers have to agree —
 * `classifyIssue` below, and the one-off importer in scripts/import-issues.ts.
 * They disagreed for months: the importer trusted the label unconditionally, so
 * 46 of 174 catalogue-backed rows were stored with the wrong flag and 45 adult
 * sources sat on the default board.
 */
export function nsfwFor(
  source: { nsfw: boolean } | undefined | null,
  labels: string[],
): boolean {
  return source ? source.nsfw : labels.includes('18+');
}

/**
 * The address a source request gives, out of the issue body.
 *
 * 02_request_source.yml has asked for it under `### Source link` since issue #9,
 * so this is reading a form field rather than guessing at prose — and it is the
 * only place the address exists. The original backlog import never captured it,
 * which is why 198 requests on the board named a site without saying which site:
 * the name alone does not identify one, and half of them are a word plus a TLD
 * somebody has to guess at.
 *
 * A missing or unfilled section answers null. `_No response_` — GitHub's
 * placeholder for a skipped optional field — has no dot in it, so normaliseUrl
 * refuses it along with the other things that are not addresses.
 */
export function sourceLinkFromBody(body: string | null): string | null {
  if (!body) return null;
  const heading = /^[ \t]*#{1,6}[ \t]*Source link[ \t]*$/im.exec(body);
  if (!heading) return null;

  for (const raw of body.slice(heading.index + heading[0].length).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // The next section started, so this one was left empty.
    if (/^#{1,6}\s/.test(line)) return null;
    // People paste a bare URL, but a markdown link happens often enough to be
    // worth the one regex — the target, not the words wrapped around it.
    const md = /\((https?:\/\/[^)\s]+)\)/.exec(line);
    return normaliseUrl(md ? md[1] : line.split(/\s+/)[0]);
  }
  return null;
}

export function classifyIssue(issue: IssueSnapshot): Classified {
  const kind = kindOf(issue.labels);
  const m = kind === 'request' ? { how: 'none' as MatchHow } : matchSourceHow(issue.title);
  const sourceId = m.sourceId ?? null;
  const lang = langOf(issue.title, m.sourceId);
  /* One string behind both the name and the headline, so they cannot disagree.
     Only a request gets the ask stripped out of it; on every other kind the
     head is a source name already and requestedName has no business touching
     it. */
  const head = headOf(issue.title);
  const named = (kind === 'request' ? requestedName(head) : null) ?? head;
  const title =
    kind === 'request' ? `Add ${named.slice(0, 70) || 'this source'}` : problemOf(issue.title);
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
    proposedName: sourceId ? null : named.slice(0, 80) || 'Unknown',
    /* Requests only, deliberately: `proposed_url` carries the request dedupe
       index, so putting a link from a bug report's body in it would make that
       report collide with an unrelated source request. A domain change has
       `new_url` for the same reason. */
    proposedUrl: kind === 'request' ? sourceLinkFromBody(issue.body) : null,
    kind,
    lang,
    nsfw: nsfwFor(source, issue.labels),
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
  /** Address for a source request (02) or removal (07). */
  proposedUrl?: string | null;
  /** New address for a domain change (03). */
  newUrl?: string | null;
  /** Free-form detail from the report form, prefilled into other-details or feature-description. */
  body?: string | null;
  /** Whether the reporter marked a request 18+. Mirrored into other-details as `18+/NSFW = yes`. */
  nsfw?: boolean | null;
  /** Versions and app for bug/domain reports. */
  extVersion?: string | null;
  appName?: string | null;
  appVersion?: string | null;
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
 * GitHub issue *forms* (YAML) are prefilled via query parameters keyed by the
 * field `id` — e.g. `?name=AniWaves&link=https://…&language=English` for
 * `02_request_source.yml`. The generic `body` parameter is for markdown
 * templates and is ignored by forms, so each kind maps its report columns onto
 * the ids its template actually exposes. The tracker backlink is written into
 * `other-details` (present on every template) so it survives into the rendered
 * issue body where `reportIdFromBody` can find it; `body` is kept as well for
 * the fallback path and for older templates. `promoteTitle` remains the
 * fallback when the backlink does not survive.
 */
export function promoteUrl(r: PromotableReport, repo: string, origin: string): string {
  const u = new URL(`https://github.com/${repo}/issues/new`);
  u.searchParams.set('template', TEMPLATES[r.kind]);
  u.searchParams.set('title', promoteTitle(r));

  const backlink = `Tracked at ${origin}/report/${r.id}`;
  // Keep `body` for the generic fallback; forms ignore unknown params, so this
  // is harmless when `other-details` is the one that actually shows.
  u.searchParams.set('body', backlink);

  const source = r.sourceId ? SOURCES.find((s) => s.id === r.sourceId) : undefined;
  const sourceName = source?.name ?? r.proposedName ?? 'Unknown';
  const langName = r.lang ? langLabel(r.lang) : '';

  // Shared builder for `other-details` — every template has it. The report's
  // own `body` (detail field) comes first so a maintainer sees the user's
  // words before the tracker bookkeeping. 1500 *encoded* chars keeps the whole
  // URL well under GitHub's ~8192 limit after percent-encoding. The backlink is
  // always kept; a very long body is truncated to make room for it rather than
  // pushing it out, because `reportIdFromBody` needs it to link the issue back.
  // LIMIT is a budget on encodeURIComponent(...) length, not UTF-16 code units,
  // so non-ASCII (e.g. 9 bytes per CJK char after encoding) cannot overflow the URL.
  const LIMIT = 1500;
  const fitEncoded = (s: string, budget: number) => {
    let out = s;
    while (out.length > 0) {
      let encLen: number;
      try {
        encLen = encodeURIComponent(out).length;
      } catch {
        // Slice landed inside a surrogate pair — drop the dangling high surrogate.
        out = out.slice(0, -1);
        continue;
      }
      if (encLen <= budget) break;
      let nextLen = Math.max(0, Math.floor(out.length * 0.9) - 1);
      // Avoid splitting a surrogate pair (emoji) which would throw on encode.
      if (nextLen > 0 && nextLen < out.length) {
        const prev = out.charCodeAt(nextLen - 1);
        const next = out.charCodeAt(nextLen);
        if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) nextLen -= 1;
      }
      // Ensure progress even when 0.9 rounding stalls on tiny strings.
      if (nextLen >= out.length) nextLen = out.length - 1;
      out = out.slice(0, nextLen);
    }
    return out;
  };
  const truncate = (s: string) => fitEncoded(s, LIMIT);
  const buildOtherDetails = (opts: { includeBody?: boolean; includeNsfw?: boolean } = {}) => {
    const includeBody = opts.includeBody !== false;
    const includeNsfw = opts.includeNsfw !== false;
    const nsfwPart = includeNsfw && r.nsfw ? '18+/NSFW = yes' : '';
    let bodyPart = includeBody && r.body ? r.body : '';
    const sep = '\n\n';
    const encodedBacklink = encodeURIComponent(backlink).length;
    const sepLen = encodeURIComponent(sep).length;
    const nsfwEncoded = nsfwPart ? encodeURIComponent(nsfwPart).length : 0;
    // Reserve encoded budget for backlink, separators and nsfwPart first.
    // Body is the only part that can be arbitrarily long, so it shrinks.
    let bodyBudget = LIMIT - encodedBacklink;
    if (nsfwPart) bodyBudget -= nsfwEncoded + sepLen;
    if (bodyPart) bodyBudget -= sepLen;
    if (bodyPart) {
      if (bodyBudget <= 0) {
        bodyPart = '';
      } else {
        bodyPart = fitEncoded(bodyPart, bodyBudget);
        // Re-shrink if rounding left us just over (double-check total).
        while (
          bodyPart.length > 0 &&
          encodeURIComponent(bodyPart).length + sepLen + encodedBacklink + (nsfwPart ? nsfwEncoded + sepLen : 0) > LIMIT
        ) {
          bodyPart = fitEncoded(bodyPart, encodeURIComponent(bodyPart).length - 1);
        }
      }
    }
    const parts: string[] = [];
    if (bodyPart) parts.push(bodyPart);
    if (nsfwPart) parts.push(nsfwPart);
    parts.push(backlink);
    return parts.join(sep);
  };

  switch (r.kind) {
    case 'request': {
      // 02_request_source.yml: name, link, language, other-details
      const name = r.proposedName ?? sourceName;
      if (name && name !== 'Unknown') u.searchParams.set('name', name);
      if (r.proposedUrl) u.searchParams.set('link', r.proposedUrl);
      if (langName) u.searchParams.set('language', langName);
      u.searchParams.set('other-details', buildOtherDetails());
      break;
    }
    case 'bug': {
      // 01_report_issue.yml: source, language, which-app, app-version, other-details
      // Source information placeholder is "AnimePahe 14.19 (English)"
      const ver = r.extVersion || source?.extVersion || '';
      const srcInfo = ver
        ? `${sourceName} ${ver} (${langName || r.lang})`
        : langName
          ? `${sourceName} (${langName})`
          : sourceName;
      u.searchParams.set('source', srcInfo);
      if (langName) u.searchParams.set('language', langName);
      if (r.appName) u.searchParams.set('which-app', r.appName);
      if (r.appVersion) u.searchParams.set('app-version', r.appVersion);
      u.searchParams.set('other-details', buildOtherDetails());
      break;
    }
    case 'domain': {
      // 03_report_url_change.yml: source, language, link (new URL), other-details
      const ver = r.extVersion || source?.extVersion || '';
      const srcInfo = ver ? `${sourceName} ${ver}` : sourceName;
      u.searchParams.set('source', srcInfo);
      if (langName) u.searchParams.set('language', langName);
      if (r.newUrl) u.searchParams.set('link', r.newUrl);
      u.searchParams.set('other-details', buildOtherDetails());
      break;
    }
    case 'dead': {
      // 04_report_dead_source.yml: source (name), language, link, other-details
      u.searchParams.set('source', sourceName);
      if (langName) u.searchParams.set('language', langName);
      const link = r.proposedUrl || source?.baseUrl || r.newUrl || null;
      if (link) u.searchParams.set('link', link);
      u.searchParams.set('other-details', buildOtherDetails());
      break;
    }
    case 'feature': {
      // 05_request_feature.yml: source, language, feature-description, other-details
      u.searchParams.set('source', sourceName);
      if (langName) u.searchParams.set('language', langName);
      // The user's ask lives in `body` (detail) and `title` (one-line headline).
      // Prefer the longer detail, fall back to the title so the field is never
      // left empty for a row that genuinely has a description.
      const feat = r.body?.trim() ? r.body : r.title;
      if (feat) u.searchParams.set('feature-description', truncate(feat));
      u.searchParams.set('other-details', backlink);
      break;
    }
    case 'meta': {
      // 06_request_meta.yml: feature-description, other-details
      const feat = r.body?.trim() ? r.body : r.title;
      if (feat) u.searchParams.set('feature-description', truncate(feat));
      u.searchParams.set('other-details', backlink);
      break;
    }
    case 'removal': {
      // 07_request_removal.yml: link, other-details
      const link = r.proposedUrl || source?.baseUrl || r.newUrl || null;
      if (link) u.searchParams.set('link', link);
      u.searchParams.set('other-details', buildOtherDetails());
      break;
    }
  }

  return u.toString();
}

/** The backlink promoteUrl plants, read back out of an issue body. */
export function reportIdFromBody(body: string | null): number | null {
  if (!body) return null;
  const m = /\/report\/(\d{1,9})\b/.exec(body);
  return m ? Number(m[1]) : null;
}
