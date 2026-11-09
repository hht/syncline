import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, test, vi } from 'vitest';
import { exportNotes } from './notes.ts';

// A private space exporting its notes to D1; vitest.config.ts sets the export delay to 0, so exports run right after each write.

const exported = async (space: string) =>
  (await env.EXPORTS.prepare('SELECT id, body FROM exported_note WHERE space = ? ORDER BY id').bind(space).all()).results;

/** Waits until the destination holds rows for space: exports run in an alarm after the write, not during it. */
const exportedTo = (space: string, rows: { id: string; body: string }[]) =>
  vi.waitFor(async () => expect(await exported(space)).toEqual(rows), { timeout: 10_000 });

test('a server write reaches D1 through the exporter', async () => {
  await env.USER_SPACE.getByName('user-1').addNote('n1', 'Hello');
  await exportedTo('user-1', [{ id: 'n1', body: 'Hello' }]);
});

test('a chunk whose from no longer matches the stored position changes nothing', async () => {
  const exporter = exportNotes(env.EXPORTS, env.USER_SPACE.idFromName('user-2'));
  const put = (id: string) => [{ op: 'put' as const, table: 'note', key: { id }, row: { id, body: id } }];
  await exporter.write({ from: undefined, next: 'p1', reset: false, patch: put('a') });
  await exporter.write({ from: undefined, next: 'p2', reset: false, patch: put('b') });
  expect(await exporter.position()).toBe('p1');
  expect(await exported('user-2')).toEqual([{ id: 'a', body: 'a' }]);
});

test('an object without a name exports nothing and throws, so the export retries', async () => {
  const exporter = exportNotes(env.EXPORTS, env.USER_SPACE.newUniqueId());
  await expect(exporter.position()).rejects.toThrow('This space has no name to export under');
});

test('after a space is rebuilt, the destination receives a full snapshot marked reset and drops the old rows', async () => {
  await env.USER_SPACE.getByName('user-3').addNote('old', 'Before the rebuild');
  await exportedTo('user-3', [{ id: 'old', body: 'Before the rebuild' }]);
  // Emptying the object's storage stands in for deleting and recreating its class: the destination keeps the old position.
  await runInDurableObject(env.USER_SPACE.getByName('user-3'), (_, state) => state.storage.deleteAll());
  await runInDurableObject(env.USER_SPACE.getByName('user-3'), (_, state) => state.abort('rebuilt')).catch(() => undefined);
  await env.USER_SPACE.getByName('user-3').addNote('new', 'After the rebuild');
  await exportedTo('user-3', [{ id: 'new', body: 'After the rebuild' }]);
});
