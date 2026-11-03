import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Storage } from '../common/storage.ts';
import { Device } from '../test/test-device.ts';
import { pulled, upload, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Space } from './space.ts';

// 只由云端写的表（readOnly）：服务端的写照常下发，设备只读；本机写改到就抛错，
// 改过的客户端推来的写改到就由云端扣下、不改行，序号照样推进，之后的写照常执行

const account = sqliteTable('account', { id: text().primaryKey(), name: text() });
const trial = sqliteTable('trial', { id: text().primaryKey(), expires_at: integer() });
const tables = [account, trial];
const statements = [
  'CREATE TABLE account (id TEXT PRIMARY KEY, name TEXT)',
  'CREATE TABLE trial (id TEXT PRIMARY KEY, expires_at INTEGER)',
];

const trials = (storage: Storage) => drizzle(storage).select().from(trial).all();
const accounts = (storage: Storage) => drizzle(storage).select().from(account).all();

/** 云端已由服务端写了一行试用；readOnly 是设备声明的只读表（改过的客户端不声明） */
async function setup(readOnly: SQLiteTable[] = [trial]) {
  const cloud = cloudStorage(...statements);
  const space = new Space(cloud, tables, { readOnly: [trial] });
  const storage = deviceStorage(...statements);
  const device = new Device(storage, tables, { readOnly });
  space.mutate((tx) => tx.insert(trial, { id: 't1', expires_at: 1 }));
  await device.private.receive(pulled(space, device));
  return { space, cloud, device, storage };
}

/** 改过的客户端（不声明只读）改了试用并推上去，云端扣下的那一条 */
async function heldTrialWrite() {
  const synced = await setup([]);
  await write(synced.device, (tx) => tx.update(trial).set({ expires_at: 2 }));
  await upload(synced.space, synced.device, [synced.device]);
  const [held] = synced.space.held();
  if (!held) throw new Error('应扣下一条写');
  return { ...synced, held };
}

test('服务端写只由云端写的表，设备照常收到', async () => {
  const { storage } = await setup();
  expect(trials(storage)).toEqual([{ id: 't1', expires_at: 1 }]);
});

test('本机写改到只由云端写的表就抛错、整条回滚，不进待上传', async () => {
  const { storage, device } = await setup();
  await expect(
    write(device, async (tx) => {
      await tx.insert(account).values({ id: 'a1', name: '甲' });
      await tx.update(trial).set({ expires_at: 2 });
    }),
  ).rejects.toThrow('只由云端写');
  expect(device.private.pending()).toEqual([]);
  expect(accounts(storage)).toEqual([]);
  expect(trials(storage)).toEqual([{ id: 't1', expires_at: 1 }]);
});

test('改过的客户端推来改到只由云端写的表的写：云端扣下、行不变，之后的写照常执行，设备撤回被扣下的', async () => {
  const { cloud, space, storage, device } = await setup([]);
  await write(device, (tx) => tx.update(trial).set({ expires_at: 2 }));
  await write(device, (tx) => tx.insert(account).values({ id: 'a1', name: '甲' }));
  await upload(space, device, [device]);
  expect(space.held()).toEqual([expect.objectContaining({ reason: expect.stringContaining('只由云端写') })]);
  expect(trials(cloud)).toEqual([{ id: 't1', expires_at: 1 }]);
  expect(accounts(cloud)).toEqual([{ id: 'a1', name: '甲' }]);
  expect(device.private.pending()).toEqual([]);
  expect(trials(storage)).toEqual([{ id: 't1', expires_at: 1 }]);
});

test('重新提交扣下的、改到只由云端写的表的写就抛错：那是设备推来的改动', async () => {
  const { space, held } = await heldTrialWrite();
  expect(() => space.resubmit(held.client, held.id)).toThrow('只由云端写');
});

test('只由云端写的表不是同步表、或引用设备能写的表（设备删父行会连带删掉它的行）：建空间、打开本机库时抛错', () => {
  const grant = sqliteTable('grant', { id: text().primaryKey(), account_id: text().references(() => account.id) });
  const other = sqliteTable('other', { id: text().primaryKey() });
  const create = (readOnly: SQLiteTable[], declared: SQLiteTable[] = tables) => [
    () => new Space(cloudStorage(...statements, 'CREATE TABLE "grant" (id TEXT PRIMARY KEY, account_id TEXT)'), declared, { readOnly }),
    () => new Device(deviceStorage(...statements, 'CREATE TABLE "grant" (id TEXT PRIMARY KEY, account_id TEXT)'), declared, { readOnly }),
  ];
  for (const open of create([other])) expect(open).toThrow('不是同步表');
  for (const open of create([grant], [...tables, grant])) expect(open).toThrow('引用了设备能写的表');
  for (const open of create([grant, account], [...tables, grant])) expect(open).not.toThrow();
});

test('表改成只读之前留下的待上传：升级后打开、重放不抛错，推上去由云端扣下，不会卡住', async () => {
  const { space, storage, device } = await setup([]);
  await write(device, (tx) => tx.update(trial).set({ expires_at: 2 }));
  const upgraded = new Device(storage, tables, { readOnly: [trial] });
  await upload(space, upgraded, [upgraded]);
  expect(space.held()).toHaveLength(1);
  expect(upgraded.private.pending()).toEqual([]);
  expect(trials(storage)).toEqual([{ id: 't1', expires_at: 1 }]);
});

test('重新提交时另给不改只由云端写的表的改动：照常执行，不再扣着', async () => {
  const { cloud, space, held } = await heldTrialWrite();
  space.resubmit(held.client, held.id, [{ op: 'put', table: 'account', row: { id: 'a2', name: '乙' } }]);
  expect(space.held()).toEqual([]);
  expect(accounts(cloud)).toEqual([{ id: 'a2', name: '乙' }]);
  expect(trials(cloud)).toEqual([{ id: 't1', expires_at: 1 }]);
});
