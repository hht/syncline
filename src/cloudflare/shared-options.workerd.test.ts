import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, expect, test } from 'vitest';
import { fannedOut } from './test-shared.ts';

// Shared space Durable Objects: options wired through (validation of server writes, retired names), and addressing by name only.

afterAll(async () => {
  await fannedOut('validated');
  await fannedOut('y'.repeat(1022));
  await fannedOut('catalog');
});

test('server writes failing validation throw without committing, and retired names are recorded on startup to stay retired', async () => {
  const space = env.CATALOG.getByName('validated');
  await expect(Promise.resolve().then(() => space.publish('v1', 'forbidden'))).rejects.toThrow('forbidden status');
  const query = (sql: string) => runInDurableObject(space, (_, state) => state.storage.sql.exec(sql).toArray());
  expect(await query('SELECT id FROM program')).toEqual([]);
  expect(await query('SELECT name FROM _syncline_retired')).toEqual([{ name: 'program.color' }]);
});

test('a shared space reached without a name (an ID from idFromString, or a shard name over 1,024 bytes) throws instead of fanning out to shards no device connects to', async () => {
  const hex = env.CATALOG.idFromName('unnamed').toString();
  await expect(Promise.resolve().then(() => env.CATALOG.get(env.CATALOG.idFromString(hex)).publish('u1'))).rejects.toThrow(
    'reach it by name',
  );
  // The test catalog has 2 shards: the longest shard name appends "#1", so 1,022 characters fit exactly
  await env.CATALOG.getByName('y'.repeat(1022)).publish('u1');
  await expect(Promise.resolve().then(() => env.CATALOG.getByName('x'.repeat(1023)).publish('u1'))).rejects.toThrow(
    'must fit in 1024 bytes',
  );
});

test('a broadcast shard reached without a name fails its queries to the space instead of asking a space no device uses', async () => {
  const round = await env.CATALOG.getByName('catalog').latest();
  const shard = env.CATALOG_BROADCAST.get(env.CATALOG_BROADCAST.idFromString(env.CATALOG_BROADCAST.idFromName('unnamed#0').toString()));
  await expect(Promise.resolve().then(() => shard.notify(round))).rejects.toThrow('reach it by name');
});
