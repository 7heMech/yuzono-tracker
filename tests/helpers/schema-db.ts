import { Database } from 'bun:sqlite';

/**
 * The migrations in drizzle/, replayed in journal order into an in-memory
 * SQLite — the same thing `bun run db:local` does to D1, minus D1.
 *
 * `bun:sqlite` ships JSON1, so statements built for D1 (json_each included)
 * run here unchanged. Anything that compiles a query against the real schema
 * can drive it through drizzle-orm/bun-sqlite against this.
 */
type Journal = { entries: { idx: number; tag: string }[] };

export async function schemaDb(): Promise<Database> {
  const repoFile = (path: string) => Bun.file(new URL(`../../${path}`, import.meta.url));
  const db = new Database(':memory:');
  const journal: Journal = await repoFile('drizzle/meta/_journal.json').json();
  const order = [...journal.entries].sort((a, b) => a.idx - b.idx);
  for (const entry of order) {
    const sql = await repoFile(`drizzle/${entry.tag}.sql`).text();
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) db.run(trimmed);
    }
  }
  return db;
}
