import { expect, test } from 'vitest';
import { parsePoke } from './parse.ts';

// 设备在边界解析云端的拉取结果与通知：只收存得下的值，清空只在开头，清一段带着主键的列

const last = (patch: unknown[]) => JSON.stringify({ base: null, cookie: { version: 1, nonce: 1 }, lmids: {}, patch });

function patchOf(text: string) {
  const poke = parsePoke(text);
  if (!('patch' in poke)) throw new Error('不是通知');
  return poke.patch;
}

test('行与主键的值只收 null、字符串与有限的数；对象、数组、布尔都当云端的缺陷拒掉，不绑进 SQL', () => {
  const put = (row: unknown) => ({ op: 'put', table: 'note', key: { id: 'n1' }, row: { id: 'n1', body: row } });
  expect(patchOf(last([put('深蹲'), put(null), put(1.5)]))).toHaveLength(3);
  for (const bad of [{ nested: 1 }, [1], true]) expect(() => parsePoke(last([put(bad)]))).toThrow('格式不对');
  expect(() => parsePoke(last([{ op: 'del', table: 'note', key: { id: [1] } }]))).toThrow('格式不对');
});

test('清空只在整份的第一块开头；在中间就拒掉', () => {
  const row = { op: 'put', table: 'note', key: { id: 'n1' }, row: { id: 'n1' } };
  expect(patchOf(last([{ op: 'clear' }, row]))).toHaveLength(2);
  expect(() => parsePoke(last([row, { op: 'clear' }]))).toThrow('格式不对');
});

test('清一段主键：带主键的列与起止，起止只收存得下的值；没有主键的列、同时给删列的都拒掉', () => {
  const range = { key: ['id'], after: { id: 'a' }, until: { id: 'b' } };
  expect(patchOf(last([{ op: 'drop', table: 'note', range }]))).toEqual([{ op: 'drop', table: 'note', range }]);
  expect(patchOf(last([{ op: 'drop', table: 'note', range: { key: ['id'] } }]))).toEqual([
    { op: 'drop', table: 'note', range: { key: ['id'] } },
  ]);
  for (const bad of [{ key: [] }, { after: { id: 'a' } }, { key: ['id'], after: { id: [1] } }, { key: ['id'], until: 'b' }])
    expect(() => parsePoke(last([{ op: 'drop', table: 'note', range: bad }]))).toThrow('格式不对');
  expect(() => parsePoke(last([{ op: 'drop', table: 'note', range, columns: ['x'] }]))).toThrow('格式不对');
});
