import { expect, test } from 'vitest';
import { parsePullBody, parsePullRequest, pullURL } from './pull-url.ts';

// Pull requests: shared space requests are encoded in the URL, private space requests in POST bodies, both validated at cloud boundaries.

test('parses private space pull bodies and rejects duplicate tables, non-objects, empty table names, or unrepresentable bounds in ranges', () => {
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
  expect(parsePullBody(JSON.stringify(request))).toEqual(request);
  expect(parsePullBody(JSON.stringify({ cookie: null }))).toEqual({ cookie: null });
  for (const bad of [
    [{ table: 'a' }, { table: 'a' }],
    'not array',
    [[]],
    [{ after: { id: 'a' } }],
    [{ table: 'a', after: { id: [1] } }],
    [{ table: '' }],
  ])
    expect(() => parsePullBody(JSON.stringify({ cookie: null, ranges: bad })), JSON.stringify(bad)).toThrow('Malformed');
});

test('rejects unexpected properties or mismatched property types in private space pull bodies', () => {
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
    expect(() => parsePullBody(JSON.stringify(body)), JSON.stringify(body)).toThrow('Malformed');
  expect(() => parsePullBody('not json')).toThrow();
});

test('accepts only recognized shared space and connection query parameters, rejecting private space parameters in URLs', () => {
  const request = { cookie: { version: 3, nonce: 7 }, cursor: 'c', landed: 'l', atLeast: 2, incarnation: 5 };
  expect(parsePullRequest(new URL(pullURL('https://sync.test/catalog', request)))).toEqual(request);
  expect([...new URL(pullURL('https://sync.test/space')).searchParams.keys()]).toEqual(['v']);
  for (const name of ['client', 'range', 'refetch'])
    expect(() => parsePullRequest(new URL(`${pullURL('https://sync.test/space')}&${name}=1`))).toThrow('Malformed');
});
