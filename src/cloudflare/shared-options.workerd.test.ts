import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';

// Shared space options wired through the Durable Object: validation of server writes and retired names.

test('server writes failing validation throw without committing, and retired names are recorded on startup to stay retired', async () => {
  const space = env.CATALOG.getByName('validated');
  await expect(Promise.resolve().then(() => space.publish('v1', 'forbidden'))).rejects.toThrow('forbidden status');
  const query = (sql: string) => runInDurableObject(space, (_, state) => state.storage.sql.exec(sql).toArray());
  expect(await query('SELECT id FROM program')).toEqual([]);
  expect(await query('SELECT name FROM _syncline_retired')).toEqual([{ name: 'program.color' }]);
});
