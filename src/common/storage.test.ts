import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { deviceStorage } from '../test/test-storage.ts';
import { isTransient, Reject } from './storage.ts';

// 云端的存储出的错是不是暂时的：workerd 与测试替身的官方 WASM 报结果码的样子不同（一个在末尾、一个在开头），都要认得

test.for([
  ['database or disk is full: SQLITE_FULL', true],
  ['disk I/O error: SQLITE_IOERR (extended: SQLITE_IOERR_WRITE)', true],
  ['SQLITE_BUSY: sqlite3 result code 5: database is locked', true],
  ['SQLITE_IOERR_WRITE: sqlite3 result code 778: disk I/O error', true],
  ['CHECK constraint failed: a + b <= 10: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)', false],
  ['SQLITE_CONSTRAINT_CHECK: sqlite3 result code 275: CHECK constraint failed', false],
  ['Cannot read properties of undefined', false],
] as const)('「%s」：暂时的是 %s', ([message, transient]) => {
  expect(isTransient(new Error(message))).toBe(transient);
});

test('平台标了 retryable 的是暂时的；不是 Error 的不是', () => {
  expect(isTransient(Object.assign(new Error('Network connection lost.'), { retryable: true }))).toBe(true);
  expect(isTransient('SQLITE_FULL')).toBe(false);
});

test('拒收（含不合声明）不是暂时的：原因里带着推来的列名、校验器报的值，恰有结果码的字样也不算（云端推送按它分）', () => {
  expect(isTransient(new Reject('改动的列不在 note 上：SQLITE_FULL'))).toBe(false);
});

test('Drizzle 照 DO 的 cursor 用 Storage：取一行（get）走 raw().next()，取多行走 toArray', () => {
  const note = sqliteTable('note', { id: text().primaryKey() });
  const storage = deviceStorage('CREATE TABLE note (id TEXT PRIMARY KEY)', "INSERT INTO note VALUES ('n1'), ('n2')");
  const db = drizzle(storage);
  expect(db.select().from(note).orderBy(note.id).get()).toEqual({ id: 'n1' });
  expect(db.select().from(note).orderBy(note.id).all()).toEqual([{ id: 'n1' }, { id: 'n2' }]);
});
