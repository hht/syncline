import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { Device } from '../test/test-device.ts';
import { pulled } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// 名字拼进 SQL 只有一种写法：标识符里的双引号、字符串字面量里的单引号都转义。
// 表名、列名只有字母、数字、下划线（声明检查），索引名里的引号照样能声明

const note = sqliteTable('note', { id: text().primaryKey(), quoted: text() }, (table) => [index('by"it\'s').on(table.quoted)]);
const plain = sqliteTable('note', { id: text().primaryKey() });

test('索引名里有双引号与单引号：整份拉取批量落地照常写进去，之后删掉这一列（先删含它的索引）照常打开', async () => {
  const cloud = cloudStorage(`CREATE TABLE note (id TEXT PRIMARY KEY, quoted TEXT)`);
  const space = new Space(cloud, [note]);
  // 多于 500 条改动走批量落地
  space.mutate((tx) => {
    for (let index = 0; index < 600; index += 1) tx.insert(note, { id: `n${index}`, quoted: `第 ${index} 条` });
  });
  const storage = deviceStorage(`CREATE TABLE note (id TEXT PRIMARY KEY, quoted TEXT)`, `CREATE INDEX "by""it's" ON note (quoted)`);
  const device = new Device(storage, [note]);
  await device.private.receive(pulled(space, device));
  expect(storage.sql.exec(`SELECT count(*) AS n FROM note WHERE quoted LIKE '第%'`).toArray()[0]?.n).toBe(600);
  new Device(storage, [plain], { retired: ['note.quoted'] });
  expect(storage.sql.exec('SELECT * FROM note LIMIT 1').toArray()[0]).not.toHaveProperty('quoted');
});
