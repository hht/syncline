import { expect, test } from 'vitest';
import { readRows } from '../../src/protocol/limits.ts';
import { cabinet } from '../support/test-cabinet.ts';

// Shard broadcast rounds that carry no rows, so shards push hints and devices pull over HTTP instead.

test('shard broadcast round carries no rows from a base off history, such as a cookie confirmed before a restore', () => {
  const { space, publish } = cabinet();
  publish('p1');
  const head = space.head();
  const forked = { version: head.version, nonce: head.nonce + 1 };
  expect(space.round(64_000, forked)).toEqual({ base: forked, cookie: head, incarnation: expect.any(Number) });
});

test('shard broadcast round carries no rows once reading the commits since base would exceed readRows', () => {
  const { space, publish } = cabinet();
  const base = space.head();
  // Each commit costs two statement rows, so readRows / 2 + 1 one-row commits exceed the budget while their keys stay within limit.
  for (let n = 0; n <= readRows / 2; n += 1) publish(`q${n}`);
  expect(space.round(Number.POSITIVE_INFINITY, base).rows).toBeUndefined();
  expect(space.round(Number.POSITIVE_INFINITY, space.head()).rows).toEqual([]);
});
