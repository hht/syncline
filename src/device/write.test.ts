import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { Device } from '../test/test-device.ts';
import { upload, write } from '../test/test-schema.ts';
import { deviceStorage, failOnce, restoredDeviceStorage } from '../test/test-storage.ts';
import { exercise, read, statements, tables, w1, withWorkout, workout } from './test-workout.ts';

// Local writes: standard Drizzle reads and writes, uploads modified rows; cloud and replay overwrite by column.

/** Tablet updates weight to 110 and pushes; phone has not received this notice yet. */
async function withTabletPoke() {
  const { space, phone, tablet } = await withWorkout();
  await write(tablet.device, (tx) => tx.update(workout).set({ weight: 110 }).where(eq(workout.id, 'w1')));
  const poke = space.push(tablet.device.private.pending());
  if (!poke) throw new Error('expected notice after cloud push');
  return { phone, poke };
}

test('pending writes are modified rows, once per row: insert gives full row, update gives modified columns, delete gives pk; insert+update merges', async () => {
  const { phone } = await withWorkout();
  await write(phone.device, async (tx) => {
    await tx.insert(workout).values({ id: 'w2', note: 'bench press', reps: null });
    await tx.update(workout).set({ reps: 8 }).where(eq(workout.id, 'w2'));
    await tx.update(workout).set({ weight: 105, done: false }).where(eq(workout.id, 'w1'));
    await tx.delete(exercise).where(eq(exercise.id, 'e1'));
  });
  const changes = phone.device.private.pending()[0]?.changes;
  expect(changes).toHaveLength(3);
  expect(changes).toEqual(
    expect.arrayContaining([
      { op: 'put', table: 'workout', row: { id: 'w2', note: 'bench press', reps: 8, weight: null, done: null, extra: null } },
      { op: 'patch', table: 'workout', row: { id: 'w1', weight: 105, done: 0 } },
      { op: 'del', table: 'exercise', key: { id: 'e1' } },
    ]),
  );
});

test('uploaded rows restore to identical values on cloud and other devices', async () => {
  const { cloud, tablet } = await withWorkout();
  expect(read(cloud).workouts).toEqual([w1]);
  expect(read(tablet.storage)).toEqual(read(cloud));
});

test('writes can read then write; throwing rolls back completely without uploading', async () => {
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
      await tx.update(workout).set({ note: 'unwritten' }).where(eq(workout.id, 'w1'));
      throw new Error('failed');
    }),
  ).rejects.toThrow('failed');
  expect(read(phone.storage).workouts).toMatchObject([{ note: 'squat', reps: 6 }]);
  expect(phone.device.private.pending().map(({ changes }) => changes)).toEqual([
    [{ op: 'patch', table: 'workout', row: { id: 'w1', reps: 6 } }],
  ]);
});

test('no-op writes are not uploaded; writing to unsynced tables throws and rolls back', async () => {
  const { phone } = await withWorkout();
  await write(phone.device, (tx) => tx.update(workout).set({ note: 'squat' }).where(eq(workout.id, 'w1')));
  phone.storage.sql.exec('CREATE TABLE scratch (id TEXT PRIMARY KEY)');
  await expect(
    phone.device.write(async (execute) => {
      execute("UPDATE workout SET note = 'unwritten'", []);
      execute("INSERT INTO scratch VALUES ('s1')", []);
    }),
  ).rejects.toThrow('local write can only modify synced');
  expect(phone.device.private.pending()).toEqual([]);
  expect(read(phone.storage).workouts).toMatchObject([{ note: 'squat' }]);
});

test.for([
  'UPDATE _syncline_cookie SET version = 999',
  "INSERT INTO _syncline_columns (name, columns) VALUES (NULL, '[]')",
  "INSERT INTO _syncline_owner (space, owner) VALUES (NULL, 'x')",
  'DELETE FROM _SYNCLINE_PENDING',
])('writing to internal tables throws and rolls back, including rows SQLite sessions do not record: %s', async (sql) => {
  const { phone } = await withWorkout();
  const cookie = phone.device.private.cookie();
  expect(cookie).not.toBeNull();
  await expect(phone.device.write(async (execute) => execute(sql, []))).rejects.toThrow('not authorized');
  expect(phone.device.private.cookie()).toEqual(cookie);
  const image = phone.storage.image();
  phone.device.close();
  expect(() => new Device(restoredDeviceStorage(image), tables)).not.toThrow();
});

test('mutating primary key behaves as deleting old row and inserting new row', async () => {
  const { phone } = await withWorkout();
  await write(phone.device, (tx) => tx.update(workout).set({ id: 'w9' }).where(eq(workout.id, 'w1')));
  expect(phone.device.private.pending()[0]?.changes).toEqual(
    expect.arrayContaining([
      { op: 'del', table: 'workout', key: { id: 'w1' } },
      { op: 'put', table: 'workout', row: { ...w1, id: 'w9', done: 1, extra: '{"rpe":8}' } },
    ]),
  );
});

test('two devices modifying different columns on same row keep both; modifying same column resolves with last-write-wins', async () => {
  const { cloud, space, phone, tablet, devices } = await withWorkout();
  await write(phone.device, (tx) => tx.update(workout).set({ note: 'front squat', reps: 3 }).where(eq(workout.id, 'w1')));
  await write(tablet.device, (tx) => tx.update(workout).set({ weight: 110, reps: 4 }).where(eq(workout.id, 'w1')));
  await upload(space, phone.device, devices);
  await upload(space, tablet.device, devices);

  expect(read(cloud).workouts).toMatchObject([{ note: 'front squat', weight: 110, reps: 4 }]);
  for (const { storage } of [phone, tablet]) expect(read(storage)).toEqual(read(cloud));
});

test('remote changes received while local write is in flight await commit then apply, with local writes replayed on top', async () => {
  const { phone, poke } = await withTabletPoke();

  let received: Promise<boolean> | undefined;
  await write(phone.device, async (tx) => {
    await tx.update(workout).set({ note: 'front squat' }).where(eq(workout.id, 'w1'));
    received = phone.device.private.receive(poke);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read(phone.storage).workouts).toMatchObject([{ note: 'front squat', weight: 102.5 }]);
  });
  expect(await received).toBe(true);
  expect(read(phone.storage).workouts).toMatchObject([{ note: 'front squat', weight: 110 }]);
  expect(phone.device.private.pending()).toHaveLength(1);
});

test('after close: open local writes roll back, queued writes and receives abort', async () => {
  const { phone, poke } = await withTabletPoke();

  const open = write(phone.device, async (tx) => {
    await tx.update(workout).set({ note: 'front squat' }).where(eq(workout.id, 'w1'));
    phone.device.close();
  });
  const received = phone.device.private.receive(poke);
  await expect(open).rejects.toThrow('local database is closed');
  await expect(received).rejects.toThrow('local database is closed');
  await expect(write(phone.device, async () => undefined)).rejects.toThrow('local database is closed');
  expect(read(phone.storage).workouts).toMatchObject([{ note: 'squat', weight: 102.5 }]);
  expect(phone.device.private.pending()).toEqual([]);
});

test('a local write whose rollback fails rolls back the whole transaction, so later writes still commit', async () => {
  const { phone } = await withWorkout();
  failOnce(phone.storage, 'ROLLBACK TO syncline_write');
  const abandoned = write(phone.device, async (tx) => {
    await tx.update(workout).set({ note: 'front squat' }).where(eq(workout.id, 'w1'));
    throw new Error('abandoned');
  });
  await expect(abandoned).rejects.toThrow('abandoned');
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'bench' }));
  expect(phone.storage.inTransaction()).toBe(false);
  expect(read(phone.storage).workouts).toMatchObject([{ id: 'w1', note: 'squat' }, { id: 'w2' }]);
  expect(phone.device.private.pending()).toHaveLength(1);
});

test('a statement run through a local write after it finished fails, leaving the database untouched', async () => {
  const { phone } = await withWorkout();
  let leaked: Parameters<Parameters<typeof write>[1]>[0] | undefined;
  await write(phone.device, async (tx) => {
    leaked = tx;
  });
  await expect(leaked?.insert(workout).values({ id: 'w2', note: 'bench' })).rejects.toMatchObject({
    cause: { message: 'this local write has already finished' },
  });
  expect(read(phone.storage).workouts).toMatchObject([{ id: 'w1' }]);
  expect(phone.device.private.pending()).toEqual([]);
});

test('closing the database while a write is validated fails that write as closed and leaves no row behind', async () => {
  const storage = deviceStorage(...statements);
  let device: Device | undefined;
  const closing = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      // The close reaches the database before the validation result does
      validate: (value: unknown) => {
        device?.close();
        return { value };
      },
    },
  };
  device = new Device(storage, tables, { validation: new Map([[workout, closing]]) });
  await expect(write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'bench' }))).rejects.toThrow('local database is closed');
  expect(read(storage).workouts).toEqual([]);
});

test('client ID retrieved via provided randomUUID (Hermes lacks Web Crypto, avoids mutating global crypto): generated on startup and resync', async () => {
  const ids = ['c-1', 'c-2'];
  const device = new Device(deviceStorage(...statements), tables, { randomUUID: () => ids.shift() ?? 'exhausted' });
  await write(device, (tx) => tx.insert(workout).values({ id: 'w1' }));
  expect(device.private.pending().map(({ client }) => client)).toEqual(['c-1']);
  await device.private.resync(true);
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2' }));
  expect(device.private.pending().map(({ client }) => client)).toEqual(['c-2']);
});

test('JSON text containing NUL is invalid on the device as on the cloud (JSON.parse rejects it; SQLite json_valid stops reading at NUL)', async () => {
  const device = new Device(deviceStorage(...statements), tables);
  const insert = device.write(async (execute) => execute("INSERT INTO workout (id, extra) VALUES ('w1', ?)", ['{}\u0000x']));
  await expect(insert).rejects.toMatchObject({ table: 'workout', issues: [{ path: ['extra'] }] });
  expect(() => JSON.parse('{}\u0000x')).toThrow();
});

test('JSON nested deeper than 1000 levels is invalid on the cloud as on the device (SQLite json_valid caps nesting at 1000)', async () => {
  const { space, phone } = await withWorkout();
  const nested = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;
  const insert = (id: string, extra: string) =>
    phone.device.write(async (execute) => execute('INSERT INTO workout (id, extra) VALUES (?, ?)', [id, extra]));
  await insert('w8', nested(1000));
  await expect(insert('w9', nested(1001))).rejects.toMatchObject({ table: 'workout', issues: [{ path: ['extra'] }] });
  expect(() => space.mutate((tx) => tx.insert(workout, { id: 'w9', extra: JSON.parse(nested(1001)) }))).toThrow('must be valid JSON');
  space.mutate((tx) => tx.insert(workout, { id: 'w8', extra: JSON.parse(nested(1000)) }));
});
