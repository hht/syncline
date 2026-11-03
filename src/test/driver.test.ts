import { expect, test } from 'vitest';
import { statementCache } from './test-driver.ts';

// 编译好的语句按 SQL 重用：同一条只编译一次，超出上限时销毁最久没用的

test('同一条 SQL 只编译一次；留着的超过 100 条时销毁最久没用的那条，用过的排到最后', () => {
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
