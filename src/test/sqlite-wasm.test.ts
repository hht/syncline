import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { expect, test } from 'vitest';
import { sqliteWasmStorage } from './test-sqlite-wasm.ts';

// Official SQLite WASM used as Storage: bindings and result extraction follow SQLite semantics.

const sqlite3 = await sqlite3InitModule();
const opened = () => sqliteWasmStorage(sqlite3, new sqlite3.oo1.DB(':memory:'));

test('integer values exceeding int64 (such as Number.MAX_VALUE) store as real without corruption', () => {
  const storage = opened();
  storage.sql.exec('CREATE TABLE t (n REAL)');
  storage.sql.exec('INSERT INTO t VALUES (?), (?)', Number.MAX_VALUE, 2 ** 70);
  expect(storage.sql.exec('SELECT n FROM t').toArray()).toEqual([{ n: Number.MAX_VALUE }, { n: 2 ** 70 }]);
});

test('cached SELECT * picks up added columns: results include new columns', () => {
  const storage = opened();
  storage.sql.exec('CREATE TABLE t (a TEXT)');
  storage.sql.exec("INSERT INTO t VALUES ('x')");
  expect(storage.sql.exec('SELECT * FROM t').toArray()).toEqual([{ a: 'x' }]);
  storage.sql.exec('ALTER TABLE t ADD COLUMN b TEXT');
  expect(storage.sql.exec('SELECT * FROM t').toArray()).toEqual([{ a: 'x', b: null }]);
});
