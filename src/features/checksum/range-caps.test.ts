import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Poke } from '../../common/protocol.ts';
import { Space } from '../../test/test-checksum.ts';
import { cloudStorage } from '../../test/test-storage.ts';

// The cloud's caps on the rows and characters of one checksum range, whatever the device asks: they bound the CPU of one request.

const entry = sqliteTable('entry', { n: integer().primaryKey(), note: text() });

/** Rows and last key of the first range of a space holding `rows` entries with notes of `chars` characters, for a device asking `checksumRows` rows. */
function firstRange(rows: number, chars: number, checksumRows?: number) {
  const cloud = cloudStorage('CREATE TABLE entry (n INTEGER PRIMARY KEY, note TEXT)');
  const space = new Space(cloud, [entry]);
  cloud.sql.exec(
    "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?) INSERT INTO entry SELECT i, printf('%.*c', ?, 'x') FROM s",
    rows,
    chars,
  );
  // The final chunk of a full pull carries the checksum.
  const asked = { cookie: null, checksum: '', ...(checksumRows && { checksumRows }) };
  let pulled = space.pull(asked, 1_000_000_000);
  while (!('cookie' in pulled)) pulled = space.pull({ ...asked, cursor: pulled.next }, 1_000_000_000);
  const checksum = (pulled as Poke).checksum;
  return [checksum?.rows, checksum?.parts.at(-1)?.until];
}

test('a device asking for more rows than a range holds gets 20,000', () => {
  expect(firstRange(20_001, 1, 1_000_000)).toEqual([20_000, { n: 20_000 }]);
});

test('a range ends once its rows pass 8,000,000 characters, whatever their number', () => {
  // Each row's text is 1,000,000 characters and its table, key, and column names: the eighth row passes the cap.
  expect(firstRange(10, 1_000_000)).toEqual([8, { n: 8 }]);
});
