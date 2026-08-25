import { describe, expect, test } from 'bun:test';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '../../src/lib/db/schema';
import { schemaDb } from '../helpers/schema-db';

/**
 * src/lib/db/schema.ts against the migrations in drizzle/.
 *
 * Drizzle's schema is what the queries are compiled from; the migrations are
 * what the database actually has. Nothing at runtime reconciles them, so a
 * column added to the schema without a generated migration is not a type error
 * or a startup failure — it is a 500 from D1 the first time a user reaches the
 * one statement that names the missing column. `status_note` shipped that way
 * and took out marking a report fixed.
 *
 * The migrations are executed as written, in journal order, against an
 * in-memory SQLite, and the result is compared with the schema Drizzle would
 * query. A forgotten `bun run db:generate` fails here.
 */

const tables = Object.values(schema).filter((v) => is(v, SQLiteTable)) as unknown as SQLiteTable[];

const db = await schemaDb();

/** Column names the migrations left on a table, in no particular order. */
const columnsOf = (table: string) =>
  db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => row.name)
    .sort();

/** Index names the migrations left on a table, drizzle-generated ones included. */
const indexesOf = (table: string) =>
  db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}' AND name NOT LIKE 'sqlite_autoindex%'`,
    )
    .all()
    .map((row) => row.name)
    .sort();

describe('migrations cover the drizzle schema', () => {
  test('every table in the schema exists', () => {
    const migrated = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'",
      )
      .all()
      .map((row) => row.name)
      .sort();
    expect(migrated).toEqual(tables.map((t) => getTableConfig(t).name).sort());
  });

  for (const table of tables) {
    const { name, columns, indexes } = getTableConfig(table);

    test(`${name} columns`, () => {
      expect(columnsOf(name)).toEqual(columns.map((c) => c.name).sort());
    });

    test(`${name} indexes`, () => {
      const wanted = indexes.map((i) => i.config.name).sort();
      expect(indexesOf(name)).toEqual(expect.arrayContaining(wanted));
    });
  }
});
