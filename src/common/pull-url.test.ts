import { expect, test } from 'vitest';
import { parsePullBody, parsePullRequest, pullBody, pullURL } from './pull-url.ts';

// 拉取的请求：共用空间的放进网址，私有空间的放进 POST 的正文，都在云端的边界认回来

test('私有空间的请求随正文来回，原样认回；按范围重下同一张表两项、不是对象、表名是空串、起止的值存不下的都拒掉', () => {
  const ranges = [{ table: 'set', after: { workoutId: 'w1', index: 0 } }, { table: 'workout', until: { id: 'w4' } }, { table: 'gone' }];
  const request = {
    cookie: { version: 3, nonce: 7 },
    cursor: 'c',
    refetch: true as const,
    checksum: '',
    checksumRows: 10,
    ranges,
    clients: ['a.b', 'c'],
    earliest: { 'a.b': 2, c: 1 },
  };
  expect(parsePullBody(pullBody(request))).toEqual(request);
  expect(parsePullBody(pullBody({ cookie: null }))).toEqual({ cookie: null });
  for (const bad of [
    [{ table: 'a' }, { table: 'a' }],
    'not array',
    [[]],
    [{ after: { id: 'a' } }],
    [{ table: 'a', after: { id: [1] } }],
    [{ table: '' }],
  ])
    expect(() => parsePullBody(JSON.stringify({ cookie: null, ranges: bad })), JSON.stringify(bad)).toThrow('格式不对');
});

test('私有空间的正文多了设备不会发的项、各项的类型不对：拒掉', () => {
  for (const body of [
    {},
    { cookie: null, landed: 'x' },
    { cookie: '3.7' },
    { cookie: null, clients: [1] },
    { cookie: null, earliest: { a: 0 } },
    { cookie: null, checksumRows: 0 },
    { cookie: null, refetch: 1 },
    { cookie: null, toString: 1 },
    JSON.parse('{"cookie":null,"__proto__":{"cursor":"c"}}'),
  ])
    expect(() => parsePullBody(JSON.stringify(body)), JSON.stringify(body)).toThrow('格式不对');
  expect(() => parsePullBody('not json')).toThrow();
});

test('网址只认共用空间与连接的几个参数：私有空间的项放进网址是设备不会发的，拒掉', () => {
  const request = { cookie: { version: 3, nonce: 7 }, cursor: 'c', landed: 'l', atLeast: 2, incarnation: 5 };
  expect(parsePullRequest(new URL(pullURL('https://sync.test/catalog', request)))).toEqual(request);
  expect([...new URL(pullURL('https://sync.test/space')).searchParams.keys()]).toEqual(['v']);
  for (const name of ['client', 'range', 'refetch'])
    expect(() => parsePullRequest(new URL(`${pullURL('https://sync.test/space')}&${name}=1`))).toThrow('格式不对');
});
