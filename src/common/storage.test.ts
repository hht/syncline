import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { deviceStorage } from '../test/test-storage.ts';
import { isTransient, Reject } from './storage.ts';

// Classifies storage errors as transient or permanent: recognizes result codes from both workerd (suffix) and official SQLite WASM (prefix).

test.for([
  ['database or disk is full: SQLITE_FULL', true],
  ['disk I/O error: SQLITE_IOERR (extended: SQLITE_IOERR_WRITE)', true],
  ['SQLITE_BUSY: sqlite3 result code 5: database is locked', true],
  ['SQLITE_IOERR_WRITE: sqlite3 result code 778: disk I/O error', true],
  ['CHECK constraint failed: a + b <= 10: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)', false],
  ['SQLITE_CONSTRAINT_CHECK: sqlite3 result code 275: CHECK constraint failed', false],
  ['Cannot read properties of undefined', false],
] as const)('classifies "%s" as transient: %s', ([message, transient]) => {
  expect(isTransient(new Error(message))).toBe(transient);
});

test('treats errors with retryable flag as transient and non-Error objects as non-transient', () => {
  expect(isTransient(Object.assign(new Error('Network connection lost.'), { retryable: true }))).toBe(true);
  expect(isTransient('SQLITE_FULL')).toBe(false);
});

test('treats Reject instances as permanent even when error messages contain SQLite result codes', () => {
  expect(isTransient(new Reject('Column missing on note: SQLITE_FULL'))).toBe(false);
});

test('supports Drizzle queries over Storage cursors using raw().next() for get() and toArray() for all()', () => {
  const note = sqliteTable('note', { id: text().primaryKey() });
  const storage = deviceStorage('CREATE TABLE note (id TEXT PRIMARY KEY)', "INSERT INTO note VALUES ('n1'), ('n2')");
  const db = drizzle(storage);
  expect(db.select().from(note).orderBy(note.id).get()).toEqual({ id: 'n1' });
  expect(db.select().from(note).orderBy(note.id).all()).toEqual([{ id: 'n1' }, { id: 'n2' }]);
});
