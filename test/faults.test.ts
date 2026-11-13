import { expect, test } from 'vitest';
import { formatCookie } from '../src/common/protocol.ts';
import { Device, Space } from './support/test-checksum.ts';
import { head } from './support/test-commits.ts';
import { counter, keys, replay, type Snapshot, schema, serverInc, snapshot, tables, tag, writes } from './support/test-counter.ts';
import { random } from './support/test-random.ts';
import { write } from './support/test-schema.ts';
import { cloudStorage, deviceStorage, failOnce, faultable, isInjected } from './support/test-storage.ts';

// Devices under storage faults (disk full, process killed between statements): receiving a chunk, receiving a poke,
// or executing a local write either takes effect in full or leaves no trace. A seed controls server writes, local writes,
// chunked pulls, pushes, and failure statement index; P5 (local = cloud at cookie + replay pending) is checked after
// every step; once faults stop, pulling and pushing converge the device with the cloud.

/** Small chunk limit: both full and incremental pulls split across multiple chunks. */
const chunkLimit = 120;

/** One cloud space and one device with simulated storage faults, fully determined by a random seed. */
class Faulty {
  readonly cloud = cloudStorage(...schema);
  readonly space = new Space(this.cloud, tables);
  readonly #faults = faultable(deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', ...schema));
  readonly device = new Device(this.#faults.storage, tables);
  readonly #pick: () => number;
  // Snapshots of every version emitted by the cloud, used to compute expected device state.
  readonly #history = new Map<string, Snapshot>([[formatCookie(head(this.cloud)), snapshot(this.cloud)]]);
  #labels = 0;

  constructor(seed: number) {
    this.#pick = random(seed);
  }

  choose<T>(items: T[]) {
    return items[Math.floor(this.#pick() * items.length)] as T;
  }

  label() {
    this.#labels += 1;
    return `t${this.#labels}`;
  }

  serverWrite() {
    this.space.mutate((tx) => serverInc(tx, this.choose(keys), this.label()));
    this.#record();
  }

  /** Executes a device step, occasionally injecting a fault at a statement index; only injected errors are caught. */
  async attempt(step: () => Promise<unknown>) {
    if (this.#pick() < 0.4) this.#faults.arm(1 + Math.floor(this.#pick() * 30));
    try {
      await step();
    } catch (error) {
      if (!isInjected(error)) throw error;
    } finally {
      this.#faults.disarm();
    }
  }

  pull() {
    return this.device.private.receive(this.space.pull(this.device.private.pullRequest(), chunkLimit));
  }

  async push() {
    const poke = this.space.push(this.device.private.pending(), chunkLimit);
    this.#record();
    if (poke && 'patch' in poke) await this.device.private.receive(poke);
  }

  /** P5: local = cloud at cookie + replay pending. */
  check() {
    const cookie = this.device.private.cookie();
    const base = cookie ? this.#history.get(formatCookie(cookie)) : { counter: [], tag: [] };
    if (!base) throw new Error('device cookie is not an emitted cloud version');
    expect(snapshot(this.#faults.storage)).toEqual(replay(base, this.device.private.pending()));
  }

  /** Pulled up to head and all writes pushed. */
  settled() {
    return (
      !this.device.private.staging() &&
      this.device.private.pending().length === 0 &&
      this.device.private.cookie()?.version === head(this.cloud).version
    );
  }

  converged() {
    return (
      this.device.private.pending().length === 0 && JSON.stringify(snapshot(this.#faults.storage)) === JSON.stringify(snapshot(this.cloud))
    );
  }

  #record() {
    this.#history.set(formatCookie(head(this.cloud)), snapshot(this.cloud));
  }
}

test.for(Array.from({ length: 100 }, (_, seed) => seed))(
  'seed %i: storage faults at any time; device steps take effect in full or leave no trace, converging once faults stop',
  async (seed) => {
    const run = new Faulty(seed);
    const { device } = run;
    for (let step = 0; step < 80; step += 1) {
      const action = run.choose(['server', 'inc', 'mark', 'remove', 'pull', 'pull', 'push'] as const);
      if (action === 'server') run.serverWrite();
      else if (action === 'pull') await run.attempt(() => run.pull());
      else if (action === 'push') await run.attempt(() => run.push());
      else await run.attempt(() => writes[action](device, run.choose(keys), run.label()));
      run.check();
    }
    // Stop faults: pull up to head and push all pending writes.
    for (let round = 0; round < 200 && !run.settled(); round += 1) {
      if (device.private.staging() || device.private.cookie()?.version !== head(run.cloud).version) await run.pull();
      else await run.push();
      run.check();
    }
    expect(run.converged()).toBe(true);
    // Verify checksums: pull with checksum computed by cloud, then verify against local ranges.
    await device.private.receive(run.space.pull({ ...device.private.pullRequest(), checksum: '' }, chunkLimit));
    expect(await device.private.verify()).toBe(true);
  },
);

/**
 * When RELEASE fails on committing a local write while the transaction remains open: leaves no trace and consumes no mutation ID;
 * the next write uses that mutation ID so pushed IDs remain sequential without gaps or duplicates.
 * @see https://sqlite.org/lang_transaction.html (Response To Errors Within A Transaction)
 */
test('local write commit RELEASE fails with open transaction: leaves no trace, next write pushes cleanly', async () => {
  const storage = deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', ...schema);
  failOnce(storage, 'RELEASE syncline_write');
  const device = new Device(storage, tables);
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, tables);
  await expect(writes.inc(device, 'a', 't1')).rejects.toThrow();
  expect(snapshot(storage)).toEqual({ counter: [], tag: [] });
  await writes.inc(device, 'a', 't2');
  await writes.inc(device, 'a', 't3');
  expect(device.private.pending().map(({ id }) => id)).toEqual([1, 2]);
  space.push(device.private.pending(), chunkLimit);
  expect(snapshot(cloud)).toEqual(snapshot(storage));
  expect(snapshot(cloud).counter).toEqual([{ id: 'a', n: 2 }]);
});

test('internal sync transaction commit RELEASE fails with open transaction: leaves no trace, subsequent writes and pulls succeed', async () => {
  const storage = deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', ...schema);
  const device = new Device(storage, tables);
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, tables);
  space.mutate((tx) => serverInc(tx, 'a', 't1'));
  const pull = () => device.private.receive(space.pull(device.private.pullRequest(), chunkLimit));
  failOnce(storage, 'RELEASE syncline');
  await expect(pull()).rejects.toThrow();
  expect(storage.inTransaction()).toBe(false);
  expect(snapshot(storage)).toEqual({ counter: [], tag: [] });
  await writes.inc(device, 'b', 't2');
  expect(storage.inTransaction()).toBe(false);
  await pull();
  space.push(device.private.pending(), chunkLimit);
  expect(snapshot(storage)).toEqual(snapshot(cloud));
});

test('device disk full (SQLITE_FULL rolls back entire transaction): throws disk full error and succeeds once space is freed', async () => {
  const storage = deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', ...schema);
  const device = new Device(storage, tables);
  const used = storage.sql.exec('PRAGMA page_count').toArray()[0]?.page_count;
  storage.sql.exec(`PRAGMA max_page_count = ${used}`);
  // Single write of ~200 KB: 400 tags with ~500-char primary keys (keyBytes cap is 512 bytes).
  const big = () =>
    write(device, async (tx) => {
      await tx.insert(counter).values({ id: 'a', n: 1 }).onConflictDoNothing();
      for (let index = 0; index < 400; index += 1) await tx.insert(tag).values({ id: `t${index}`.padEnd(490, 'x'), counter_id: 'a' });
    });
  // Drizzle wraps driver errors, original error in cause.
  await expect(big()).rejects.toMatchObject({ cause: { message: expect.stringMatching(/full/) } });
  storage.sql.exec('PRAGMA max_page_count = 1073741823');
  await big();
  expect(device.private.pending()).toHaveLength(1);
});
