import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import { CAUSES, KINDS, STAGES } from '../../src/lib/db/schema';
import { PROBLEM_KEYS, problemKeyFor } from '../../src/lib/problems';

/**
 * `problemKeyFor` in src/lib/problems.ts against the `CASE` in
 * drizzle/0005_problem_key_and_board_indexes.sql.
 *
 * These two derive the same thing in two languages. The migration backfilled
 * `reports.problem` for the 468 rows already in production; the script derives
 * it again every time the seed is regenerated. `problem` is the third column of
 * the partial unique index `reports_open_per_source_problem`, so if the two ever
 * disagree about what a (kind, stage, cause) triple means, the symptom is not an
 * error — it is a reporter being told "someone already reported this" about a
 * problem nobody reported, or two rows for one problem escaping dedupe.
 *
 * Neither side is reimplemented here. The SQL is executed as written, out of the
 * migration file, against an in-memory SQLite table, and compared against the
 * real exported function. **If you change either one, change the other** — this
 * test is the thing that will tell you.
 */

/** Named for the error messages; resolved off this file so cwd cannot matter. */
const MIGRATION = 'drizzle/0005_problem_key_and_board_indexes.sql';
const repoFile = (path: string) => Bun.file(new URL(`../../${path}`, import.meta.url));

type Triple = { kind: string; stage: string | null; cause: string | null };
const key = (t: Triple) => `${t.kind}|${t.stage ?? 'NULL'}|${t.cause ?? 'NULL'}`;

/** Every (kind, stage, cause) the schema's enums allow, nulls included. */
const TRIPLES: Triple[] = [];
for (const kind of KINDS) {
  for (const stage of [null, ...STAGES]) {
    for (const cause of [null, ...CAUSES]) TRIPLES.push({ kind, stage, cause });
  }
}

/**
 * The migration's statements, in file order, filtered to the ones that write
 * `problem`. Statements are separated by drizzle's `--> statement-breakpoint`
 * marker, and each may carry the leading `--` comments that explain it.
 */
function problemUpdates(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((stmt) => /^UPDATE\s+`reports`\s+SET\s+`problem`/i.test(stmt));
}

let updates: string[];

beforeAll(async () => {
  updates = problemUpdates(await repoFile(MIGRATION).text());
});

/**
 * Every row in the fixture carries a `source_id`, so the migration's final
 * statement applies to all of them — which is the question the function has to
 * be asked to match. `withoutSource` is the other half of that argument, and it
 * is what the first three statements alone correspond to.
 */
const withSource = (t: Triple) => problemKeyFor(t.kind, t.stage, t.cause, true);
const withoutSource = (t: Triple) => problemKeyFor(t.kind, t.stage, t.cause, false);

/**
 * Runs the given migration statements over a table holding one row per triple,
 * and returns what the SQL decided for each. `source_id` is set on every row
 * because the last statement in the migration is conditional on it.
 */
function runSql(statements: string[]): Map<string, string | null> {
  const db = new Database(':memory:');
  db.run(
    'CREATE TABLE `reports` (`rowkey` text, `kind` text, `stage` text, `cause` text, `problem` text, `source_id` text)',
  );
  const insert = db.prepare(
    'INSERT INTO `reports` (`rowkey`, `kind`, `stage`, `cause`, `problem`, `source_id`) VALUES (?, ?, ?, ?, NULL, ?)',
  );
  for (const t of TRIPLES) insert.run(key(t), t.kind, t.stage, t.cause, 'some-source-id');
  for (const stmt of statements) db.run(stmt);
  const rows = db
    .query('SELECT `rowkey`, `problem` FROM `reports`')
    .all() as { rowkey: string; problem: string | null }[];
  db.close();
  return new Map(rows.map((r) => [r.rowkey, r.problem]));
}

describe('problem key derivation', () => {
  test('the migration still contains the statements this test mirrors', () => {
    // Three kind-keyed statements derive the key: 'moved' for a domain change,
    // 'gone' for a dead source, and the CASE over stage and cause for a bug.
    // A fourth backstops rows that hang off a source but got no key; it is
    // deliberately excluded below — see the test that covers it.
    expect(updates).toHaveLength(4);
    expect(updates[0]).toMatch(/'moved'/);
    expect(updates[1]).toMatch(/'gone'/);
    expect(updates[2]).toMatch(/CASE/);
  });

  /** Reported as a list rather than a count, so a failure names the triple. */
  function disagreements(
    statements: string[],
    fn: (t: Triple) => string | null,
  ): string[] {
    const sql = runSql(statements);
    const out: string[] = [];
    for (const t of TRIPLES) {
      const fromSql = sql.get(key(t)) ?? null;
      const fromFn = fn(t);
      if (fromSql !== fromFn) out.push(`${key(t)}: sql=${fromSql} fn=${fromFn}`);
    }
    return out;
  }

  test('the SQL and the function agree on every triple the schema allows', () => {
    // 224 triples: 7 kinds x 4 stages (including none) x 8 causes (including
    // none). Exhaustive on purpose — a disagreement on one rarely-seen
    // combination is exactly the kind that reaches production unnoticed.
    //
    // All four statements against `hasSource: true`, because every fixture row
    // has a source_id. This is the case that actually shipped: it is what the
    // migration did to the 468 rows in production.
    expect(TRIPLES).toHaveLength(KINDS.length * (STAGES.length + 1) * (CAUSES.length + 1));
    expect(disagreements(updates, withSource)).toEqual([]);
  });

  test('the derivation alone agrees with hasSource: false', () => {
    // The first three statements are the derivation; the fourth is the
    // backstop, which only fires when there is a source. Dropping both together
    // has to keep them in step, or `hasSource` is not modelling the SQL's
    // `source_id IS NOT NULL` predicate — it is just a second opinion.
    expect(disagreements(updates.slice(0, 3), withoutSource)).toEqual([]);
  });

  test('every key either is null or names a real problem', () => {
    // A key outside PROBLEM_KEYS violates the column's enum, and the enum is
    // not enforced by SQLite — Drizzle only types it. It would be stored.
    for (const t of TRIPLES) {
      for (const derived of [withSource(t), withoutSource(t)]) {
        if (derived !== null) expect(PROBLEM_KEYS as readonly string[]).toContain(derived);
      }
    }
  });

  test('the three kinds with a problem in the taxonomy always get one', () => {
    // Spelled out separately from the loop, so the intent is readable without
    // running the SQL: a bug, a domain change and a dead source are the three
    // kinds a person can file against a source, and each must dedupe.
    // And `hasSource` must not be what decides it for these three: a bug is a
    // bug whether or not the source matched the catalogue.
    for (const t of TRIPLES.filter((t) => ['bug', 'domain', 'dead'].includes(t.kind))) {
      expect(withoutSource(t), key(t)).not.toBeNull();
      expect(withSource(t), key(t)).toBe(withoutSource(t)!);
    }
    const at = (kind: string, stage: string | null, cause: string | null) =>
      withoutSource({ kind, stage, cause });
    expect(at('domain', null, null)).toBe('moved');
    expect(at('dead', 'browse', 'down')).toBe('gone');
    expect(at('bug', 'video', 'extractor')).toBe('no-video');
    expect(at('bug', 'episodes', 'other')).toBe('no-episodes');
    expect(at('bug', 'browse', 'cloudflare')).toBe('blocked');
    expect(at('bug', 'browse', 'geo')).toBe('blocked');
    expect(at('bug', 'browse', 'down')).toBe('no-browse');
    expect(at('bug', null, null)).toBe('other');
  });

  test('a null cause on a browse failure is "no-browse", not "blocked"', () => {
    // SQLite's three-valued logic is the trap here: `cause IN ('cloudflare',
    // 'geo')` evaluates to NULL rather than false when cause is NULL, so the
    // CASE falls through to the next WHEN. It happens to land on the same
    // answer the script gives, and it is worth pinning that it does.
    const sql = runSql(updates.slice(0, 3));
    expect(sql.get('bug|browse|NULL')).toBe('no-browse');
    expect(withoutSource({ kind: 'bug', stage: 'browse', cause: null })).toBe('no-browse');
  });

  test('the backstop applies only to rows that hang off a source', () => {
    // The fourth statement. Its own comment explains why: a NULL in the third
    // column of a partial unique
    // index means the row never conflicts with anything, so a report with no
    // derivable problem would escape dedupe entirely. A request for a site that
    // does not exist yet has nothing to dedupe against, so it correctly gets
    // nothing — which is why this is a predicate and not a blanket default.
    const derived = runSql(updates.slice(0, 3));
    const backstopped = runSql(updates);
    for (const t of TRIPLES.filter((t) => !['bug', 'domain', 'dead'].includes(t.kind))) {
      expect(derived.get(key(t)), `derived ${key(t)}`).toBeNull();
      expect(backstopped.get(key(t)), `backstopped ${key(t)}`).toBe('other');
      // Both sides of the function, matching each half of the SQL.
      expect(withoutSource(t), `fn without source ${key(t)}`).toBeNull();
      expect(withSource(t), `fn with source ${key(t)}`).toBe('other');
    }
    // It changes nothing for the kinds the derivation already covered.
    for (const t of TRIPLES.filter((t) => ['bug', 'domain', 'dead'].includes(t.kind))) {
      expect(backstopped.get(key(t)), key(t)).toBe(derived.get(key(t))!);
    }
  });
});
