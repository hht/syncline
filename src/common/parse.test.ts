import { expect, test } from 'vitest';
import { parsePoke } from './parse.ts';

// Device parses pull responses and notifications at the trust boundary: accepts only SQLite primitives, clears only at chunk start, and requires primary key columns for ranges.

const last = (patch: unknown[]) => JSON.stringify({ base: null, cookie: { version: 1, nonce: 1 }, lmids: {}, patch });

function patchOf(text: string) {
  const poke = parsePoke(text);
  if (!('patch' in poke)) throw new Error('Poke expected');
  return poke.patch;
}

test('accepts only null, string, and finite numbers for row and key values, rejecting objects, arrays, and booleans', () => {
  const put = (row: unknown) => ({ op: 'put', table: 'note', key: { id: 'n1' }, row: { id: 'n1', body: row } });
  expect(patchOf(last([put('squat'), put(null), put(1.5)]))).toHaveLength(3);
  for (const bad of [{ nested: 1 }, [1], true]) expect(() => parsePoke(last([put(bad)]))).toThrow('Malformed');
  expect(() => parsePoke(last([{ op: 'del', table: 'note', key: { id: [1] } }]))).toThrow('Malformed');
});

test('allows clear only at the start of the first chunk and rejects it midway', () => {
  const row = { op: 'put', table: 'note', key: { id: 'n1' }, row: { id: 'n1' } };
  expect(patchOf(last([{ op: 'clear' }, row]))).toHaveLength(2);
  expect(() => parsePoke(last([row, { op: 'clear' }]))).toThrow('Malformed');
});

test('drops primary key range with valid bounds and rejects missing primary keys or conflicting column drops', () => {
  const range = { key: ['id'], after: { id: 'a' }, until: { id: 'b' } };
  expect(patchOf(last([{ op: 'drop', table: 'note', range }]))).toEqual([{ op: 'drop', table: 'note', range }]);
  expect(patchOf(last([{ op: 'drop', table: 'note', range: { key: ['id'] } }]))).toEqual([
    { op: 'drop', table: 'note', range: { key: ['id'] } },
  ]);
  for (const bad of [{ key: [] }, { after: { id: 'a' } }, { key: ['id'], after: { id: [1] } }, { key: ['id'], until: 'b' }])
    expect(() => parsePoke(last([{ op: 'drop', table: 'note', range: bad }]))).toThrow('Malformed');
  expect(() => parsePoke(last([{ op: 'drop', table: 'note', range, columns: ['x'] }]))).toThrow('Malformed');
});
