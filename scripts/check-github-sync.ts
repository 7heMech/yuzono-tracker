/**
 * End-to-end check of the GitHub sync against a running dev server.
 *
 * Not a `bun test` file: it needs `bun run dev` up and it writes to the local
 * D1, which the unit suite deliberately never does. The pure logic — signature
 * verification, the status mapping, the transition table, the matching tiers —
 * is covered in tests/lib/github.test.ts and runs in CI. What is only checkable
 * here is the part that lives in SQL: the claim columns, the announcement cap,
 * and above all that a scheduled pass never reverts a moderator.
 *
 *   bun run dev                                  # in another terminal
 *   bun scripts/check-github-sync.ts
 *
 * It resets local report statuses as it goes, so run `bun run db:seed`
 * afterwards to put the development database back.
 */

import { Database } from 'bun:sqlite';
import { sign, type IssueSnapshot } from '../src/lib/github';

const BASE = process.env.TRACKER_URL ?? 'http://localhost:4321';
const SECRET = process.env.TRACKER_SYNC_SECRET ?? 'localcheck';

/* The Miniflare-backed D1 file, found by looking for the one carrying our
   tables — there is more than one and which is which is not stable. */
const dir = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const dbPath = (() => {
  for (const f of new Bun.Glob('*.sqlite').scanSync(dir)) {
    try {
      const d = new Database(`${dir}/${f}`, { readonly: true });
      const hit = d
        .query("select count(*) c from sqlite_master where name in ('reports','github_issues')")
        .get() as { c: number };
      d.close();
      if (hit.c === 2) return `${dir}/${f}`;
    } catch {
      // Not a database we can read; keep looking.
    }
  }
  throw new Error('no local D1 found — run `bun run db:local` first');
})();

const q = (sql: string) => {
  const d = new Database(dbPath, { readonly: true });
  const r = d.query(sql).all() as Record<string, unknown>[];
  d.close();
  return r;
};
const write = (sql: string) => {
  const d = new Database(dbPath);
  d.run(sql);
  d.close();
};
const one = (sql: string) => q(sql)[0];

let fails = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};

const iss = (o: Partial<IssueSnapshot>): IssueSnapshot => ({
  number: 0, title: '', state: 'open', stateReason: null, body: null,
  labels: [], createdAt: 1700000000, updatedAt: 1700000000, reactions: 0, ...o,
});

async function send(issues: IssueSnapshot[], backfill = false) {
  const body = JSON.stringify({ issues, backfill });
  const res = await fetch(`${BASE}/github/sync`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tracker-signature': await sign(SECRET, body),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return JSON.parse(text) as Record<string, number>;
}

write(`INSERT INTO settings (key, value) VALUES ('github_sync_secret', '${SECRET}')
       ON CONFLICT(key) DO UPDATE SET value = '${SECRET}'`);
write('DELETE FROM github_issues');

const status = (id: number) => one(`select status from reports where id=${id}`)?.status;
const linked = q('select id, github_issue from reports where github_issue is not null order by id limit 2');
if (linked.length < 2) throw new Error('needs seeded reports with issue numbers — run `bun run db:seed`');
const [a, b] = linked as { id: number; github_issue: number }[];

console.log('\n--- the endpoint refuses anything unsigned ---');
for (const [name, headers] of [
  ['no signature', {}],
  ['malformed signature', { 'x-tracker-signature': 'sha256=nope' }],
] as const) {
  const res = await fetch(`${BASE}/github/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });
  ok(`${name} is refused without reaching the sync`, res.status === 404, `status=${res.status}`);
}

console.log('\n--- a closure applies, once ---');
write(`update reports set status='open' where id=${a.id}`);
await send([iss({ number: a.github_issue, title: 'x', state: 'open' })]);
let r = await send([iss({ number: a.github_issue, title: 'x', state: 'closed', stateReason: 'completed' })]);
ok('the report was closed', status(a.id) === 'fixed', `status=${status(a.id)}`);
r = await send([iss({ number: a.github_issue, title: 'x', state: 'closed', stateReason: 'completed' })]);
ok('a repeat pass changes nothing', r.changed === 0, JSON.stringify(r));

console.log('\n--- a reopen is honoured ---');
r = await send([iss({ number: a.github_issue, title: 'x', state: 'open', stateReason: 'reopened' })]);
ok('the report reopened as confirmed', status(a.id) === 'confirmed', `status=${status(a.id)}`);

console.log('\n--- a moderator fix is never reverted ---');
/* The case this whole file exists for. This app cannot close a GitHub issue, so
   "fixed here, still open there" is the normal resting state after every fix. A
   pass that treated that disagreement as an instruction would undo the
   moderator, on every run, and nobody would notice for weeks. */
write(`update reports set status='fixed' where id=${b.id}`);
write(`delete from github_issues where number=${b.github_issue}`);
for (const pass of [1, 2]) {
  r = await send([iss({ number: b.github_issue, title: 'y', state: 'open' })]);
  ok(`pass ${pass} left it fixed`, status(b.id) === 'fixed', `status=${status(b.id)} changed=${r.changed}`);
}
const mism = one(
  `select count(*) c from github_issues gi join reports r on r.id = gi.report_id
   where gi.state='open' and r.status in ('fixed','wont_fix','duplicate')`,
) as { c: number };
ok('it is listed as a mismatch instead', mism.c >= 1, `mismatches=${mism.c}`);

console.log('\n--- an old backlog is retired rather than announced ---');
/* Without this, an install whose operator forgets `--backfill` would work
   through hundreds of historical fixes five per pass. */
write("update reports set fix_announced_at = null, status_changed_at = unixepoch() - 86400*90 where status='fixed'");
const backlog = (one("select count(*) c from reports where status='fixed' and fix_announced_at is null") as { c: number }).c;
r = await send([iss({ number: 999999, title: 'unrelated' })]);
const left = (one("select count(*) c from reports where status='fixed' and fix_announced_at is null") as { c: number }).c;
ok('nothing was announced', r.announced === 0, `announced=${r.announced}`);
ok('and the backlog was cleared silently', left === 0, `before=${backlog} after=${left}`);

console.log('\n--- matching decides adopt vs review ---');
const before = (one('select count(*) c from reports') as { c: number }).c;
r = await send([iss({ number: 999001, title: 'Totally Made Up Site [EN]: broken' })]);
ok('an unknown source is queued, not filed', r.review === 1 && (one('select count(*) c from reports') as { c: number }).c === before, JSON.stringify(r));

console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILURES`}`);
console.log('Local data was modified. Run `bun run db:seed` to reset it.');
process.exit(fails ? 1 : 0);
