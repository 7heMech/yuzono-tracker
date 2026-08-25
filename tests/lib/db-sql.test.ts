import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { inIds } from '../../src/lib/db/sql';

/**
 * The helper alone: what SQL it compiles to and how many parameters it spends.
 *
 * One bound parameter regardless of list length is the whole point — D1 caps
 * parameters at 100 per statement, which is the limit this exists to clear.
 */

const dialect = new SQLiteSyncDialect();
const compile = (fragment: ReturnType<typeof inIds>) => dialect.sqlToQuery(fragment);

describe('inIds', () => {
  test('compiles to an IN over json_each with a single parameter', () => {
    const { sql: text, params } = compile(inIds(sql`source_id`, ['1', '2', '3']));
    expect(text).toContain('IN (SELECT value FROM json_each');
    expect(params.length).toBe(1);
  });

  test('one parameter for one id', () => {
    const { params } = compile(inIds(sql`source_id`, ['1']));
    expect(params.length).toBe(1);
  });

  test('still one parameter for 400 ids — the regression this exists for', () => {
    // 400 is 4x past D1's per-statement cap; drizzle's inArray would spend
    // 400 placeholders here and D1 would refuse the statement.
    const ids = Array.from({ length: 400 }, (_, i) => String(i));
    const { params } = compile(inIds(sql`source_id`, ids));
    expect(params.length).toBe(1);
  });

  test('the parameter round-trips as JSON', () => {
    const ids = ['9168084761765988435', '2', 'three'];
    const { params } = compile(inIds(sql`source_id`, ids));
    expect(JSON.parse(params[0] as string)).toEqual(ids);
  });

  test('an empty list compiles rather than throwing', () => {
    // json_each('[]') yields zero rows, so the UPDATE matches nothing — the
    // guard callers used to need is gone, not replaced with another one here.
    const { params } = compile(inIds(sql`source_id`, []));
    expect(params.length).toBe(1);
    expect(JSON.parse(params[0] as string)).toEqual([]);
  });
});
