import { expect, test } from 'vitest';
import { Device } from '../test/test-device.ts';
import { faultyRustStorage } from '../test/test-rust.ts';
import { putWorkout, workout, workouts, write } from '../test/test-schema.ts';
import { injectedError } from '../test/test-storage.ts';

// Rolling back failing on file I/O: SQLite then rolls back the whole transaction itself (only file databases, whose journals are files).
// @see https://sqlite.org/lang_transaction.html (Response To Errors Within A Transaction)

test('a landing whose read fails, and whose rollback to its savepoint then fails on file I/O, throws the read failure, leaves no transaction open, and lands on the next try', async () => {
  const storage = faultyRustStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)');
  const device = new Device(storage, [workout]);
  const mirror = device.private;
  await mirror.receive({ base: null, cookie: { version: 1, nonce: 1 }, lmids: {}, patch: [{ op: 'clear' }, putWorkout('a', 'one')] });
  // Landing reverts the pending write, then reads its row back to replay it: that read fails with the revert in the journal
  await write(device, (tx) => tx.insert(workout).values({ id: 'c', note: 'pending' }));
  const next = { base: { version: 1, nonce: 1 }, cookie: { version: 2, nonce: 2 }, lmids: {}, patch: [putWorkout('b', 'two')] };
  // A failing read leaves the transaction open, so the landing rolls back to its savepoint
  storage.database.inject(JSON.stringify([{ prefix: 'SELECT "id"' }, { io: 'ROLLBACK TO syncline' }]));
  await expect(mirror.receive(next)).rejects.toThrow(injectedError);
  // Both faults fired
  expect(storage.database.inject('[]')).toBe(false);
  expect(storage.inTransaction()).toBe(false);
  expect([mirror.cookie(), workouts(storage).map(({ id }) => id)]).toEqual([{ version: 1, nonce: 1 }, ['a', 'c']]);
  await mirror.receive(next);
  expect([mirror.cookie(), workouts(storage).map(({ id }) => id)]).toEqual([{ version: 2, nonce: 2 }, ['a', 'b', 'c']]);
});
