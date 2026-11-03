import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { cloudStorage } from '../test/test-storage.ts';
import { Space } from './space.ts';

// 服务端的写报的主键是库里存下的值（与设备推来的写一样）：调用方给的值按列的类型存（整数列把 "5" 存成 5），
// 提交记录里同一行只有一种写法，不然同一行被当成两行（拉取给两次、删不掉、改前它在的桶对不上）

const item = sqliteTable('item', { id: integer().primaryKey(), name: text() });

test('服务端的写给整数主键传了字符串：提交记录记库里存下的数，同一行再按数改，通知里只有一行', () => {
  const space = new Space(cloudStorage('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)'), [item]);
  const base = space.head();
  space.mutate((tx) => tx.insert(item, { id: '5' as never, name: '深蹲' }));
  space.mutate((tx) => tx.update(item, { id: 5, name: '硬拉' }));
  const { patch } = pushedSince(space, base);
  expect(patch).toEqual([{ op: 'put', table: 'item', key: { id: 5 }, row: { id: 5, name: '硬拉' } }]);
});

test('服务端的写复用同一个对象删几行（删完一行改它的主键再删）：攒着的删除按调用那一刻的主键，几行都删掉', () => {
  const space = new Space(cloudStorage('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)'), [item]);
  space.mutate((tx) => {
    tx.insert(item, { id: 1, name: '深蹲' });
    tx.insert(item, { id: 2, name: '硬拉' });
  });
  const base = space.head();
  space.mutate((tx) => {
    const key = { id: 1 };
    tx.delete(item, key);
    key.id = 2;
    tx.delete(item, key);
  });
  const { patch } = pushedSince(space, base);
  expect(patch).toEqual([
    { op: 'del', table: 'item', key: { id: 1 } },
    { op: 'del', table: 'item', key: { id: 2 } },
  ]);
});

/** base 之后改到的行（拉取的增量，一块给完） */
function pushedSince(space: Space, base: ReturnType<Space['head']>) {
  const pulled = space.pull({ cookie: base }, 1_000_000_000);
  if (!('cookie' in pulled)) throw new Error('应一块给完');
  return pulled;
}
