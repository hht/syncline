import { expect, test } from 'vitest';
import { statementCache } from './support/test-driver.ts';

// Prepared statements are reused by SQL: compiled once per SQL text, finalizing LRU statements when exceeding capacity.

test('compiles each SQL text once, evicting the least recently used statement when exceeding 100', () => {
  const prepared: string[] = [];
  const finalized: string[] = [];
  const statement = statementCache(
    (sql) => {
      prepared.push(sql);
      return sql;
    },
    (sql) => finalized.push(sql),
  );
  for (let n = 0; n < 100; n += 1) statement(`SELECT ${n}`);
  expect(statement('SELECT 0')).toBe('SELECT 0');
  expect(prepared).toHaveLength(100);
  expect(finalized).toEqual([]);

  statement('SELECT 100');
  expect(finalized).toEqual(['SELECT 1']);
  statement('SELECT 1');
  expect(prepared).toHaveLength(102);
  expect(finalized).toEqual(['SELECT 1', 'SELECT 2']);
});
