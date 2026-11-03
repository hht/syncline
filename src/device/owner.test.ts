import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { AccountMismatch, PendingWrites } from '../expo/errors.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, tables, workout, workouts, write } from '../test/test-schema.ts';
import { deviceStorage } from '../test/test-storage.ts';

// 一个 App 一个库：私有空间属于登录的人、共用空间按登录的人清：换了人先清掉上一个人的，同一个人接着用

const program = sqliteTable('program', { id: text().primaryKey() });
const createProgram = 'CREATE TABLE program (id TEXT PRIMARY KEY)';
const synced = { base: null, cookie: { version: 1, nonce: 1 }, lmids: {} };

/** 一台设备：私有空间收下一行、又写了一条没上传的；共用空间（登录的人是 admin）收下一个计划 */
async function used() {
  const storage = deviceStorage(createWorkout, createProgram);
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.private.receive({
    ...synced,
    patch: [{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: '云端的' } }],
  });
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: '没上传' }));
  const catalog = device.shared('catalog', [program], 'admin');
  await catalog.receive({ ...synced, patch: [{ op: 'put', table: 'program', key: { id: 'draft' }, row: { id: 'draft' } }] });
  device.close();
  return storage;
}

const programs = (storage: ReturnType<typeof deviceStorage>) => storage.sql.exec('SELECT id FROM program').toArray();

test('换了人打开、上一个人还有没上传的写：抛 PendingWrites（是谁的、几条），什么都不清；同一个人再打开，私有数据、没上传的写、游标都在', async () => {
  const storage = await used();
  expect(() => new Device(storage, tables, { owner: 'bob' })).toThrow(expect.objectContaining({ owner: 'alice', count: 1 }));
  expect(() => new Device(storage, tables, { owner: 'bob' })).toThrow(PendingWrites);
  const device = new Device(storage, tables, { owner: 'alice' });
  expect(workouts(storage)).toHaveLength(2);
  expect(device.private.pendingCount()).toBe(1);
  expect(device.private.cookie()).toEqual({ version: 1, nonce: 1 });
  expect(storage.sql.exec('PRAGMA secure_delete').toArray()).toEqual([{ secure_delete: 0 }]);
  device.close();
  new Device(storage, tables, { owner: 'bob', discardPending: true }).close();
  expect(workouts(storage)).toEqual([]);
});

test('换了人打开、明确丢弃没上传的写：上一个人的私有数据、没上传的写、游标都清掉，整份重下；共用空间照样留着', async () => {
  const storage = await used();
  const device = new Device(storage, tables, { owner: 'bob', discardPending: true });
  expect(workouts(storage)).toEqual([]);
  expect(device.private.pendingCount()).toBe(0);
  expect(device.private.cookie()).toBeNull();
  expect(programs(storage)).toEqual([{ id: 'draft' }]);
});

test('共用空间换了登录的人：上一个人看过的行先清掉，不留给看不到它的人；人没变照样留着', async () => {
  const storage = await used();
  const device = new Device(storage, tables, { owner: 'bob', discardPending: true });
  await device.shared('catalog', [program], 'admin').opened();
  expect(programs(storage)).toEqual([{ id: 'draft' }]);
  device.close();
  const reopened = new Device(storage, tables, { owner: 'bob' });
  const catalog = reopened.shared('catalog', [program], 'public');
  await catalog.opened();
  expect(programs(storage)).toEqual([]);
  expect(catalog.cookie()).toBeNull();
});

test('云端说的空间与第一次同步时记下的不同（这台设备上换了账号，token 已是别人的）：抛 AccountMismatch，这条不收；换了 owner 才重新记', async () => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.private.receive({
    ...synced,
    space: 'alice',
    patch: [{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: '爱丽丝的' } }],
  });
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: '没上传' }));
  await expect(
    device.private.receive({ base: device.private.cookie(), cookie: { version: 2, nonce: 2 }, lmids: {}, patch: [], space: 'bob' }),
  ).rejects.toThrow(AccountMismatch);
  await expect(device.private.notified({ hint: { version: 9, nonce: 9 }, space: 'bob' }, false)).rejects.toThrow(AccountMismatch);
  expect([workouts(storage).length, device.private.pendingCount(), device.private.cookie()]).toEqual([2, 1, { version: 1, nonce: 1 }]);
  device.close();

  const bob = new Device(storage, tables, { owner: 'bob', discardPending: true });
  await bob.private.receive({
    ...synced,
    space: 'bob',
    patch: [{ op: 'put', table: 'workout', key: { id: 'w3' }, row: { id: 'w3', note: '鲍勃的' } }],
  });
  expect(workouts(storage)).toEqual([{ id: 'w3', note: '鲍勃的' }]);
});

test('换了人打开：上一个人的数据在库文件里也抹掉（删掉的行的内容清零，不留在空闲页里）', async () => {
  const storage = deviceStorage(createWorkout);
  const alice = new Device(storage, tables, { owner: 'alice' });
  const secret = '爱丽丝的秘密'.repeat(20);
  await alice.private.receive({ ...synced, patch: [{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: secret } }] });
  await write(alice, (tx) => tx.insert(workout).values({ id: 'w2', note: secret }));
  alice.close();
  new Device(storage, tables, { owner: 'bob', discardPending: true }).close();
  const image = new TextDecoder('utf-8', { fatal: false }).decode(storage.image());
  expect(image.includes('爱丽丝的秘密')).toBe(false);
});
