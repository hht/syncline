import { env, exports } from 'cloudflare:workers';
import { forwardShared } from 'syncline/cloudflare';
import { expect, test } from 'vitest';
import { connect, pull, tokenFor } from './client.ts';
import { shared } from './definition.ts';

// The shared space through the entry Worker: server writes, pulls by bucket, and live updates.

const space = () => env.SHARED_SPACE.getByName('shared');
const reader = { id: 'reader', admin: false, teams: [] as string[], level: 1 };
const admin = { ...reader, id: 'admin', admin: true };
const ids = (rows: Record<string, unknown>[] = []) => rows.map((row) => row.id).sort();

test('a pull returns the rows of subscribed buckets only', async () => {
  await space().importDocuments('first', [
    { id: 'd1', team_id: 'team-a', level: 9, status: 'published', title: 'Published' },
    { id: 'd2', team_id: 'team-a', level: 9, status: 'draft', title: 'Draft' },
    { id: 'd3', team_id: 'team-b', level: 9, status: 'draft', title: 'Team B draft' },
    { id: 'd4', team_id: 'team-c', level: 2, status: 'draft', title: 'Level 2 draft' },
  ]);
  expect(ids((await pull(await tokenFor(reader))).rows.document)).toEqual(['d1']);
  expect(ids((await pull(await tokenFor({ ...reader, teams: ['team-b'] }))).rows.document)).toEqual(['d1', 'd3']);
  expect(ids((await pull(await tokenFor({ ...reader, level: 2 }))).rows.document)).toEqual(['d1', 'd4']);
  expect(ids((await pull(await tokenFor(admin))).rows.document)).toEqual(['d1', 'd2', 'd3', 'd4']);
});

test('publishing a document makes its revisions and sections visible in the same write', async () => {
  await space().importDocuments('second', [{ id: 'p1', team_id: 'team-a', level: 9, status: 'draft', title: 'Parent' }]);
  await space().addRevision('p1', 'r1', 1, [{ id: 's1', body: 'Body' }]);
  const before = (await pull(await tokenFor(reader))).rows;
  expect([ids(before.revision), ids(before.section)]).toEqual([[], []]);
  await space().setStatus('p1', 'published');
  const after = (await pull(await tokenFor(reader))).rows;
  expect([ids(after.revision), ids(after.section)]).toEqual([['r1'], ['s1']]);
  // Devices never receive the cloud-only status copies.
  expect(after.section).toEqual([{ id: 's1', revision_id: 'r1', body: 'Body' }]);
});

test('importing a document again with another status copies the status onto its revisions and sections', async () => {
  await space().importDocuments('third', [{ id: 'i1', team_id: 'team-a', level: 9, status: 'published', title: 'Imported' }]);
  await space().addRevision('i1', 'ir1', 1, [{ id: 'is1', body: 'Body' }]);
  await space().importDocuments('fourth', [{ id: 'i1', team_id: 'team-a', level: 9, status: 'draft', title: 'Imported' }]);
  const rows = (await pull(await tokenFor(reader))).rows;
  expect(ids(rows.revision)).not.toContain('ir1');
  expect(ids(rows.section)).not.toContain('is1');
});

test('a connected device receives a server write live', async () => {
  const token = await tokenFor(reader);
  const { cookie } = await pull(token);
  const device = await connect(token, cookie);
  await device.next();
  await space().importDocuments('live', [{ id: 'l1', team_id: 'team-a', level: 9, status: 'published', title: 'Live' }]);
  expect(await device.next()).toEqual([
    { op: 'put', table: 'document', key: { id: 'l1' }, row: { id: 'l1', team_id: 'team-a', level: 9, status: 'published', title: 'Live' } },
  ]);
  device.close();
});

test('a token the entry cannot verify is refused with 401', async () => {
  const response = await exports.default.fetch('https://example.test/shared?v=5', { headers: { Authorization: 'Bearer forged' } });
  expect(response.status).toBe(401);
});

test('bucket parameters take strings for text columns and numbers for integer columns', async () => {
  const route = { entry: exports.SharedEntry, broadcast: env.SHARED_BROADCAST, space: 'shared', definition: shared };
  const pullWith = (bucket: [string, ...(string | number)[]]) =>
    forwardShared(new Request('https://example.test/shared?v=5', { headers: { Authorization: 'Bearer t' } }), route, async () => ({
      buckets: [bucket],
      expiresAt: Date.now() + 60_000,
    }));
  expect((await pullWith(['level', 2])).status).toBe(200);
  await expect(pullWith(['level', '2'])).rejects.toThrow('Invalid parameters');
  await expect(pullWith(['team', 7])).rejects.toThrow('Invalid parameters');
});

test('the entry must be passed as ctx.exports.SharedEntry itself: fetch with a props option drops them', async () => {
  const props = { space: 'shared', subscription: ['["public"]'], sub: 'example' };
  expect((await exports.SharedEntry({ props }).fetch('https://example.test/shared?v=5')).status).toBe(200);
  const outcome = await exports.SharedEntry.fetch('https://example.test/shared?v=5', { props } as RequestInit).then(
    (response) => String(response.status),
    (error: unknown) => String(error),
  );
  expect(outcome).toContain('SynclineSharedEntry received no props');
});
