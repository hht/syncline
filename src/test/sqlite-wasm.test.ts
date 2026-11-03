import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { expect, test } from 'vitest';
import { sqliteWasmStorage } from './test-sqlite-wasm.ts';

// 官方 SQLite WASM 当作 Storage 用：绑定与取结果照 SQLite 本身的语义

const sqlite3 = await sqlite3InitModule();
const opened = () => sqliteWasmStorage(sqlite3, new sqlite3.oo1.DB(':memory:'));

test('超出 int64 的整数值（如 Number.MAX_VALUE）照小数存，不写坏', () => {
  const storage = opened();
  storage.sql.exec('CREATE TABLE t (n REAL)');
  storage.sql.exec('INSERT INTO t VALUES (?), (?)', Number.MAX_VALUE, 2 ** 70);
  expect(storage.sql.exec('SELECT n FROM t').toArray()).toEqual([{ n: Number.MAX_VALUE }, { n: 2 ** 70 }]);
});

test('编译好的 SELECT * 遇到加列：结果带上新列', () => {
  const storage = opened();
  storage.sql.exec('CREATE TABLE t (a TEXT)');
  storage.sql.exec("INSERT INTO t VALUES ('x')");
  expect(storage.sql.exec('SELECT * FROM t').toArray()).toEqual([{ a: 'x' }]);
  storage.sql.exec('ALTER TABLE t ADD COLUMN b TEXT');
  expect(storage.sql.exec('SELECT * FROM t').toArray()).toEqual([{ a: 'x', b: null }]);
});
