import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { Device } from '../test/test-device.ts';
import { upload, write } from '../test/test-schema.ts';
import { deviceStorage } from '../test/test-storage.ts';
import { exercise, read, statements, tables, w1, withWorkout, workout } from './test-workout.ts';

// 本机写：普通的 Drizzle 读写，上传它改到的行；云端与重放按列覆盖

/** 平板把重量改成 110 并推送，手机还没收到这条通知 */
async function withTabletPoke() {
  const { space, phone, tablet } = await withWorkout();
  await write(tablet.device, (tx) => tx.update(workout).set({ weight: 110 }).where(eq(workout.id, 'w1')));
  const poke = space.push(tablet.device.private.pending());
  if (!poke) throw new Error('云端有新提交，应当发出通知');
  return { phone, poke };
}

test('待上传是改到的行，每行一次：插入给整行（各种列的值照 SQLite 存的），修改只给主键与改了的列，删除只给主键；同一行先插后改合成一次插入', async () => {
  const { phone } = await withWorkout();
  await write(phone.device, async (tx) => {
    await tx.insert(workout).values({ id: 'w2', note: '卧推', reps: null });
    await tx.update(workout).set({ reps: 8 }).where(eq(workout.id, 'w2'));
    await tx.update(workout).set({ weight: 105, done: false }).where(eq(workout.id, 'w1'));
    await tx.delete(exercise).where(eq(exercise.id, 'e1'));
  });
  const changes = phone.device.private.pending()[0]?.changes;
  expect(changes).toHaveLength(3);
  expect(changes).toEqual(
    expect.arrayContaining([
      { op: 'put', table: 'workout', row: { id: 'w2', note: '卧推', reps: 8, weight: null, done: null, extra: null } },
      { op: 'patch', table: 'workout', row: { id: 'w1', weight: 105, done: 0 } },
      { op: 'del', table: 'exercise', key: { id: 'e1' } },
    ]),
  );
});

test('上传的行在云端与另一台设备上还原成同样的值', async () => {
  const { cloud, tablet } = await withWorkout();
  expect(read(cloud).workouts).toEqual([w1]);
  expect(read(tablet.storage)).toEqual(read(cloud));
});

test('写里可以先读再写；抛错整条回滚，不上传', async () => {
  const { phone } = await withWorkout();
  await write(phone.device, async (tx) => {
    const [found] = await tx.select().from(workout).where(eq(workout.id, 'w1'));
    await tx
      .update(workout)
      .set({ reps: (found?.reps ?? 0) + 1 })
      .where(eq(workout.id, 'w1'));
  });
  await expect(
    write(phone.device, async (tx) => {
      await tx.update(workout).set({ note: '没写成' }).where(eq(workout.id, 'w1'));
      throw new Error('坏了');
    }),
  ).rejects.toThrow('坏了');
  expect(read(phone.storage).workouts).toMatchObject([{ note: '深蹲', reps: 6 }]);
  expect(phone.device.private.pending().map(({ changes }) => changes)).toEqual([
    [{ op: 'patch', table: 'workout', row: { id: 'w1', reps: 6 } }],
  ]);
});

test('什么也没改的写不上传；写不同步的表抛错并回滚', async () => {
  const { phone } = await withWorkout();
  await write(phone.device, (tx) => tx.update(workout).set({ note: '深蹲' }).where(eq(workout.id, 'w1')));
  phone.storage.sql.exec('CREATE TABLE scratch (id TEXT PRIMARY KEY)');
  await expect(
    phone.device.write(async (execute) => {
      execute("UPDATE workout SET note = '没写成'", []);
      execute("INSERT INTO scratch VALUES ('s1')", []);
    }),
  ).rejects.toThrow('只能写同步表');
  expect(phone.device.private.pending()).toEqual([]);
  expect(read(phone.storage).workouts).toMatchObject([{ note: '深蹲' }]);
});

test('改主键等于删掉旧行、插入新行', async () => {
  const { phone } = await withWorkout();
  await write(phone.device, (tx) => tx.update(workout).set({ id: 'w9' }).where(eq(workout.id, 'w1')));
  expect(phone.device.private.pending()[0]?.changes).toEqual(
    expect.arrayContaining([
      { op: 'del', table: 'workout', key: { id: 'w1' } },
      { op: 'put', table: 'workout', row: { ...w1, id: 'w9', done: 1, extra: '{"rpe":8}' } },
    ]),
  );
});

test('两台设备改同一行的不同列都留下，改同一列后到的覆盖', async () => {
  const { cloud, space, phone, tablet, devices } = await withWorkout();
  await write(phone.device, (tx) => tx.update(workout).set({ note: '前蹲', reps: 3 }).where(eq(workout.id, 'w1')));
  await write(tablet.device, (tx) => tx.update(workout).set({ weight: 110, reps: 4 }).where(eq(workout.id, 'w1')));
  await upload(space, phone.device, devices);
  await upload(space, tablet.device, devices);

  expect(read(cloud).workouts).toMatchObject([{ note: '前蹲', weight: 110, reps: 4 }]);
  for (const { storage } of [phone, tablet]) expect(read(storage)).toEqual(read(cloud));
});

test('本机写开着时收到的云端改动等它提交后再应用，之后重放在它之上', async () => {
  const { phone, poke } = await withTabletPoke();

  let received: Promise<boolean> | undefined;
  await write(phone.device, async (tx) => {
    await tx.update(workout).set({ note: '前蹲' }).where(eq(workout.id, 'w1'));
    received = phone.device.private.receive(poke);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read(phone.storage).workouts).toMatchObject([{ note: '前蹲', weight: 102.5 }]);
  });
  expect(await received).toBe(true);
  expect(read(phone.storage).workouts).toMatchObject([{ note: '前蹲', weight: 110 }]);
  expect(phone.device.private.pending()).toHaveLength(1);
});

test('关掉之后：开着的本机写回滚，排着的写与收取不再执行', async () => {
  const { phone, poke } = await withTabletPoke();

  const open = write(phone.device, async (tx) => {
    await tx.update(workout).set({ note: '前蹲' }).where(eq(workout.id, 'w1'));
    phone.device.close();
  });
  const received = phone.device.private.receive(poke);
  await expect(open).rejects.toThrow('本机库已关闭');
  await expect(received).rejects.toThrow('本机库已关闭');
  await expect(write(phone.device, async () => undefined)).rejects.toThrow('本机库已关闭');
  expect(read(phone.storage).workouts).toMatchObject([{ note: '深蹲', weight: 102.5 }]);
  expect(phone.device.private.pending()).toEqual([]);
});

test('客户端编号由给的 randomUUID 取（手机上 Hermes 没有 Web Crypto，不改全局的 crypto）：每次启动、每次被重置各取一个', async () => {
  const ids = ['c-1', 'c-2'];
  const device = new Device(deviceStorage(...statements), tables, { randomUUID: () => ids.shift() ?? '没了' });
  await write(device, (tx) => tx.insert(workout).values({ id: 'w1' }));
  expect(device.private.pending().map(({ client }) => client)).toEqual(['c-1']);
  await device.private.resync(true);
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2' }));
  expect(device.private.pending().map(({ client }) => client)).toEqual(['c-2']);
});
