import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { SynclineEvent } from '../../src/cloud/events.ts';
import { HeldWrites } from '../../src/cloud/held.ts';
import { readBytes } from '../../src/cloud/limits.ts';
import { Server, type Socket } from '../../src/cloud/server.ts';
import { Space } from '../../src/cloud/space.ts';
import type { Change, Poke } from '../../src/protocol/messages.ts';
import { parseMutations } from '../../src/protocol/parse.ts';
import { queryOf } from '../../src/sqlite/storage.ts';
import { Device } from '../support/test-device.ts';
import { captureReported } from '../support/test-errors.ts';
import { pulled, upload, write } from '../support/test-schema.ts';
import { RecordingSocket } from '../support/test-sockets.ts';
import { cloudStorage, deviceStorage, failOnce, injectedError } from '../support/test-storage.ts';

// Held writes (pending remediation): non-executable writes advance lmid and persist raw payload; subsequent writes push normally; resubmission recovers data without loss.

const workbook = sqliteTable('workbook', { id: text().primaryKey(), note: text() });
const excerpt = sqliteTable('excerpt', { id: text().primaryKey(), workbook_id: text().references(() => workbook.id) });
const tables = [workbook, excerpt];
const statements = [
  'CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT)',
  'CREATE TABLE excerpt (id TEXT PRIMARY KEY, workbook_id TEXT)',
];

/** Held write notice received by phone: excerpt e1 references deleted workbook w1. */
const heldE1 = [
  { reason: expect.stringContaining('missing parent'), changes: [{ op: 'put', table: 'excerpt', row: { id: 'e1', workbook_id: 'w1' } }] },
];

/** Sets up cloud and two synced devices with existing workbook w1 on cloud. */
async function setup() {
  const cloud = cloudStorage(...statements);
  const events: SynclineEvent[] = [];
  const space = new Space(cloud, tables, { events: (event) => events.push(event) });
  space.mutate((tx) => tx.insert(workbook, { id: 'w1' }));
  const install = async () => {
    const storage = deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', ...statements);
    const device = new Device(storage, tables);
    await device.private.receive(pulled(space, device));
    const held: { reason: string; changes: Change[] }[] = [];
    device.onHeld((writes) => held.push(...writes));
    return { storage, device, held };
  };
  const phone = await install();
  const tablet = await install();
  const excerpts = (storage: Parameters<typeof drizzle>[0]) => drizzle(storage).select().from(excerpt).orderBy(excerpt.id).all();
  const devices = [phone.device, tablet.device];
  /** Phone adds excerpt referencing w1 (present locally), tablet deletes w1 before phone uploads (both receive deletion); phone subsequently uploads and cloud holds the write. */
  const holdOne = async () => {
    await write(phone.device, (tx) => tx.insert(excerpt).values({ id: 'e1', workbook_id: 'w1' }));
    await write(tablet.device, (tx) => tx.delete(workbook));
    await upload(space, tablet.device, devices);
  };
  /** Uploads phone mutation after holdOne and returns held write record. */
  const uploadHeld = async () => {
    await holdOne();
    await upload(space, phone.device, devices);
    const [held] = space.held();
    if (!held) throw new Error('Expected one held write');
    return held;
  };
  /** Catches up both devices to head. */
  const pullAll = async () => {
    for (const device of devices) await device.private.receive(space.pull({ cookie: device.private.cookie() }, 1_000_000) as never);
  };
  return { cloud, space, phone, tablet, devices, excerpts, holdOne, uploadHeld, pullAll, events };
}

test('write committed after pull request dispatched (current client) is pushed and held, confirmed in final chunk: notices held write', async () => {
  const { space, phone, tablet } = await setup();
  await write(tablet.device, (tx) => tx.delete(workbook));
  await upload(space, tablet.device, [tablet.device]);
  const request = phone.device.private.pullRequest();
  await write(phone.device, (tx) => tx.insert(excerpt).values({ id: 'e1', workbook_id: 'w1' }));
  // Push poke failed to deliver (or could not chain cookie), so write is confirmed in final chunk of pull.
  space.push(phone.device.private.pending());
  await phone.device.private.receive(space.pull(request, 1_000_000));
  expect(phone.device.private.pending()).toEqual([]);
  expect(phone.held).toEqual(heldE1);
});

test('referenced row deleted by another device: mutation is held, reverted locally, onHeld receives reason and raw changes; subsequent writes upload normally', async () => {
  const { cloud, space, phone, tablet, devices, excerpts, holdOne } = await setup();
  await holdOne();
  await write(phone.device, async (tx) => {
    await tx.insert(workbook).values({ id: 'w2' });
    await tx.insert(excerpt).values({ id: 'e2', workbook_id: 'w2' });
  });
  await upload(space, phone.device, devices);

  expect(phone.device.private.pending()).toEqual([]);
  expect(phone.held).toEqual(heldE1);
  expect(tablet.held).toEqual([]);
  expect(excerpts(cloud)).toEqual([{ id: 'e2', workbook_id: 'w2' }]);
  expect(excerpts(phone.storage)).toEqual(excerpts(cloud));
  expect(space.held()).toEqual([
    {
      client: expect.any(String),
      id: 1,
      reason: expect.stringContaining('missing parent'),
      version: expect.any(Number),
      at: expect.any(Number),
      changes: expect.any(Array),
    },
  ]);
});

test('push held and connection drops before poke arrives: reconnect catch-up confirms clients with commits after cookie, emits held writes, recognized by originator and ignored by other devices', async () => {
  const { space, phone, tablet, holdOne } = await setup();
  await holdOne();
  // Push executed and held; poke undelivered due to disconnection.
  space.push(phone.device.private.pending());
  const server = new Server<Socket>({ acceptWebSocket: () => undefined, getWebSockets: () => [] }, space);
  const connect = (device: Device) => {
    const socket = new RecordingSocket();
    server.accept(socket, device.private.cookie(), Number.POSITIVE_INFINITY);
    return JSON.parse(socket.sent[0] as string) as Poke;
  };
  const catchUp = connect(phone.device);
  expect(catchUp.held).toEqual([
    { client: phone.device.private.pullRequest().clients?.[0], id: 1, reason: expect.stringContaining('missing parent') },
  ]);
  await phone.device.private.receive(catchUp);
  expect(phone.held).toEqual([{ reason: expect.stringContaining('missing parent'), changes: expect.any(Array) }]);
  await tablet.device.private.receive(connect(tablet.device));
  expect(tablet.held).toEqual([]);
});

test('resubmit after remediation: re-executing held write after restoring parent row succeeds, unholds write, and syncs to both devices; throwing (including on replacement text with a lone surrogate) continues hold', async () => {
  const { cloud, space, phone, tablet, excerpts, uploadHeld, pullAll, events } = await setup();
  const { client, id } = await uploadHeld();
  expect(events).toContainEqual({ type: 'write.held', client, id, reason: expect.stringContaining('missing parent') });

  expect(() => space.resubmit(client, id)).toThrow('missing parent');
  expect(() => space.resubmit(client, id, [{ op: 'put', table: 'excerpt', row: { id: 'e\uD800', workbook_id: null } }])).toThrow(
    'Malformed',
  );
  expect(space.held()).toHaveLength(1);
  space.mutate((tx) => tx.insert(workbook, { id: 'w1', note: 'restored' }));
  const poke = space.resubmit(client, id);
  await pullAll();
  expect(poke.patch).toEqual([{ op: 'put', table: 'excerpt', key: { id: 'e1' }, row: { id: 'e1', workbook_id: 'w1' } }]);
  expect(space.held()).toEqual([]);
  expect(events).toContainEqual({ type: 'write.resubmitted', client, id });
  expect(excerpts(cloud)).toEqual([{ id: 'e1', workbook_id: 'w1' }]);
  expect(excerpts(phone.storage)).toEqual(excerpts(cloud));
  expect(excerpts(tablet.storage)).toEqual(excerpts(cloud));
});

test('discard held write: resubmitting with empty changes clears held write without altering data, sync proceeds normally', async () => {
  const { cloud, space, phone, tablet, devices, excerpts, uploadHeld, pullAll, events } = await setup();
  const { client, id } = await uploadHeld();
  const poke = space.resubmit(client, id, []);
  await pullAll();
  // Touching no rows records no commit version: only removes held write record.
  expect(poke.cookie).toEqual(poke.base);
  expect(poke.patch).toEqual([]);
  expect(space.held()).toEqual([]);
  expect(events).toContainEqual({ type: 'write.resubmitted', client, id });
  expect(excerpts(cloud)).toEqual([]);
  expect(excerpts(phone.storage)).toEqual([]);
  expect(excerpts(tablet.storage)).toEqual([]);
  expect(() => space.resubmit(client, id)).toThrow('Held write not found');
  await write(tablet.device, async (tx) => {
    await tx.insert(workbook).values({ id: 'w2' });
    await tx.insert(excerpt).values({ id: 'e2', workbook_id: 'w2' });
  });
  await upload(space, tablet.device, devices);
  expect(excerpts(phone.storage)).toEqual([{ id: 'e2', workbook_id: 'w2' }]);
});

test('held write with large payload exceeding 2 MB DO value limit: stores across multiple rows and retrieves intact', async () => {
  const { space, phone, tablet, devices } = await setup();
  // JSON primary key up to 512 bytes: primary key ~500 chars, writing multiple rows to exceed 2 MB.
  const note = 'x'.repeat(490);
  await write(phone.device, async (tx) => {
    for (let start = 0; start < 4500; start += 500)
      await tx.insert(excerpt).values(Array.from({ length: 500 }, (_, e) => ({ id: `e${start + e}${note}`, workbook_id: 'w1' })));
  });
  await write(tablet.device, (tx) => tx.delete(workbook));
  await upload(space, tablet.device, devices);
  const [mutation] = phone.device.private.pending();
  await upload(space, phone.device, devices);
  const [held] = space.held();
  expect(JSON.stringify(held?.changes).length).toBeGreaterThan(2_000_000);
  expect(held?.changes).toEqual(mutation?.changes);
});

test('integrator events callback throws (logging error): still holds write and confirms push without marking push failed; logs error', async () => {
  const reported = captureReported();
  const space = new Space(cloudStorage(...statements), tables, {
    events: () => {
      throw new Error('Logging error');
    },
  });
  const poke = space.push([{ client: 'c1', id: 1, changes: [{ op: 'put', table: 'excerpt', row: { id: 'e1', workbook_id: 'gone' } }] }]);
  expect(poke).toMatchObject({ lmids: { c1: 1 }, held: [{ client: 'c1', id: 1 }] });
  expect(reported).toContain('Logging error');
});

test('incremental vacuum failure (e.g. disk full): held notice still emitted; vacuum runs after commit and reports error without failing chunk ingestion', async () => {
  const { space, phone, holdOne } = await setup();
  await holdOne();
  space.push(phone.device.private.pending());
  // Two additional cloud writes: pull splits into two chunks; vacuum runs when final chunk arrives.
  space.mutate((tx) => tx.insert(workbook, { id: 'w2' }));
  space.mutate((tx) => tx.insert(workbook, { id: 'w3' }));
  failOnce(phone.storage, 'PRAGMA incremental_vacuum');
  const reported = captureReported();
  const first = space.pull(phone.device.private.pullRequest(), 1);
  expect(first).toHaveProperty('next');
  expect(await phone.device.private.receive(first)).toBe(true);
  for (let step = 0; phone.device.private.behind() && step < 100; step += 1)
    expect(await phone.device.private.receive(space.pull(phone.device.private.pullRequest(), 1))).toBe(true);
  await vi.waitFor(() => expect(reported).toContainEqual(expect.stringMatching(injectedError)));
  expect(phone.held).toEqual([{ reason: expect.stringContaining('missing parent'), changes: expect.any(Array) }]);
});

test('push and final chunk query held writes by version range: utilizes covering index without full table scan as held count grows', () => {
  const cloud = cloudStorage(...statements);
  new Space(cloud, tables);
  const plan = cloud.sql
    .exec('EXPLAIN QUERY PLAN SELECT client, mutation_id, reason FROM _syncline_held WHERE part = 0 AND version > ? ORDER BY version', 0)
    .toArray()
    .map(({ detail }) => String(detail));
  expect(plan.join('; ')).toMatch(/USING (COVERING )?INDEX/);
});

test('full pull final chunk includes only held writes from requested clients starting from their earliest pending ID: omits earlier writes and other devices', async () => {
  const { space, phone, holdOne } = await setup();
  const [{ client } = { client: '' }] = await (async () => {
    await holdOne();
    return phone.device.private.pending();
  })();
  await upload(space, phone.device, [phone.device]);
  const held = (earliest?: Record<string, number>) => {
    const pull = space.pull({ cookie: null, clients: [client], ...(earliest && { earliest }) }, 1_000_000);
    if (!('cookie' in pull)) throw new Error('Expected pull to complete in a single chunk');
    return pull.held;
  };
  expect(held()).toBeUndefined();
  expect(held({ [client]: 1 })).toEqual([{ client, id: 1, reason: expect.any(String) }]);
  expect(held({ [client]: 2 })).toBeUndefined();
  expect(held({ other: 1 })).toBeUndefined();
});

test('held write with 4-byte surrogate pair spanning across chunk boundary: retrieves intact without splitting pair', () => {
  const cloud = cloudStorage(...statements);
  new Space(cloud, tables);
  const query = queryOf(cloud);
  const writes = new HeldWrites(query);
  // JSON starts with [{"op":"put","table":"excerpt","row":{"id":", followed by emoji positioned across 500,000th code unit boundary.
  const prefix = JSON.stringify([{ op: 'put', table: 'excerpt', row: { id: '' } }]).indexOf('""') + 1;
  const id = `${'x'.repeat(500_000 - prefix - 1)}${'😀'.repeat(10)}`;
  const changes = [{ op: 'put' as const, table: 'excerpt', row: { id } }];
  writes.add(1, { client: 'c1', id: 1, reason: 'test' }, changes);
  expect(writes.changes('c1', 1)).toEqual(changes);
});

test('resubmitting an unheld write (already resubmitted or never held): throws without re-executing; held writes paginate correctly', async () => {
  const { space, phone, devices, holdOne } = await setup();
  await holdOne();
  await upload(space, phone.device, devices);
  const [{ client, id } = { client: '', id: 0 }] = space.held();
  space.mutate((tx) => tx.insert(workbook, { id: 'w1', note: 'restored' }));
  space.resubmit(client, id);
  expect(() => space.resubmit(client, id, [{ op: 'put', table: 'workbook', row: { id: 'w9' } }])).toThrow('Held write not found');
  expect(() => space.resubmit('nobody', 1, [{ op: 'put', table: 'workbook', row: { id: 'w9' } }])).toThrow('Held write not found');
  expect(space.held({ limit: 1 })).toEqual([]);
});

test('list held writes paginates by bytes: large entries yield fewer items per page, reading ~readBytes plus one item; subsequent pages retrieve remainder', () => {
  const cloud = cloudStorage(...statements);
  new Space(cloud, tables);
  const writes = new HeldWrites(queryOf(cloud));
  const big = (index: number) => [{ op: 'put' as const, table: 'workbook', row: { id: `w${index}`, note: 'x'.repeat(readBytes / 2) } }];
  for (let index = 1; index <= 5; index += 1) writes.add(index, { client: 'c1', id: index, reason: 'test' }, big(index));
  const first = writes.list();
  expect(first.map(({ id }) => id)).toEqual([1, 2]);
  const rest = writes.list({ after: first.at(-1)?.version ?? 0 });
  expect(rest.map(({ id }) => id)).toEqual([3, 4]);
});

test('held reasons are bounded and well-formed: an oversized name or a cut surrogate pair still holds the write', () => {
  // Malformed change whose 200-character snippet ends inside an emoji's surrogate pair.
  const prefix = JSON.stringify({ op: 'put', table: 'workbook', row: { id: '' } }).indexOf('""') + 1;
  const cut = { op: 'put', table: 'workbook', row: { id: `${'x'.repeat(199 - prefix)}${'😀'.repeat(5)}`, note: {} } };
  for (const change of [{ op: 'put', table: 'x'.repeat(2_100_000), row: { id: 'a' } }, cut]) {
    const space = new Space(cloudStorage(...statements), tables);
    space.push(parseMutations(JSON.stringify([{ client: 'c1', id: 1, changes: [change] }])));
    const [held] = space.held();
    expect(held?.reason.length).toBeLessThanOrEqual(1000);
    expect(held?.reason.isWellFormed()).toBe(true);
  }
});
