import { and, eq, getTableColumns, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import fc from 'fast-check';
import { afterEach, expect, test, vi } from 'vitest';
import type { Space } from '../../../cloud/space.ts';
import type { Device } from '../../../test/test-device.ts';
import { failure, upload } from '../../../test/test-roundtrip.ts';
import { write } from '../../../test/test-schema.ts';
import { restoredStorage } from '../../../test/test-storage.ts';
import { char, type item, itemChange, itemRow } from '../../../test/test-values.ts';
import type { Exporter, Exports } from './exports.ts';
import { type Chunk, chore, cloud, created, exportsTo, Replica, type Storage, specs, stored } from './test-replica.ts';

// An exporter whose destination writes each delivered chunk and its next position in one transaction ends with exactly the cloud's
// rows, whatever mix of server writes and device pushes produced them, while the destination fails before or after committing,
// alarm runs run out of budget, chunks end anywhere (inside a commit too), writes land while the destination is awaited, and the
// commit log is truncated or the cloud recovered to a backup between runs. Expected rows are read from the cloud tables with plain
// SQL, never through the reader.

type Spec = (typeof specs)[number];

/** One synced row write: table index, key slot in that table's key pool, and non-key values. */
type RowWrite = { table: number; slot: number; how: 'insert' | 'upsert' | 'update' | 'delete'; values: Record<string, unknown> };

const note = fc.record({ note: fc.option(fc.string({ unit: char, maxLength: 20 })) }, { requiredKeys: [] });
const valuesOf = [itemChange, note, note, note] as fc.Arbitrary<RowWrite['values']>[];

const rowWrite = (hows: RowWrite['how'][]): fc.Arbitrary<RowWrite> =>
  fc.oneof(
    ...valuesOf.map((values, table) => fc.record({ table: fc.constant(table), slot: fc.nat(2), how: fc.constantFrom(...hows), values })),
  );

const unique = <T>(value: fc.Arbitrary<T>, selector: (value: T) => unknown) =>
  fc.uniqueArray(value, { minLength: 1, maxLength: 3, selector });

/** Primary keys each table's writes draw from, so later writes update and delete earlier rows; reals include ones past the safe integer range. */
const pools = fc.tuple(
  unique(
    itemRow.map(({ id }) => ({ id })),
    ({ id }) => id,
  ),
  unique(
    fc
      .oneof(fc.integer({ min: -2, max: 2 }), fc.maxSafeInteger(), fc.constantFrom(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER))
      .map((id) => ({ id })),
    ({ id }) => id + 0,
  ),
  unique(fc.record({ name: fc.string({ unit: char, maxLength: 6 }), n: fc.integer({ min: -2, max: 2 }) }), ({ name, n }) =>
    JSON.stringify([name, n]),
  ),
  unique(
    fc
      .oneof(fc.double({ noNaN: true, noDefaultInfinity: true }), fc.constantFrom(0.2 + 0.01, 2 ** 63, -(2 ** 63), 1e300, 5e-324))
      .map((at) => ({ at })),
    ({ at }) => at + 0,
  ),
);
type Pools = Record<string, unknown>[][];

/**
 * A step of the scenario: a server write (one commit of several rows), a device transaction (one pushed mutation once uploaded),
 * an upload of the device's pending writes, an alarm-driven export until caught up, a commit log truncation, a backup of the cloud
 * database, or a point-in-time recovery to the latest backup (the object restarts, and the device reinstalls from scratch).
 */
type Step = { kind: 'server' | 'device'; writes: RowWrite[] } | { kind: 'upload' | 'export' | 'truncate' | 'backup' | 'restore' };

const writes = (kind: 'server' | 'device', hows: RowWrite['how'][], maxLength: number) =>
  fc.record({ kind: fc.constant(kind), writes: fc.array(rowWrite(hows), { minLength: 1, maxLength }) });

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: writes('server', ['insert', 'upsert', 'update', 'delete'], 4) },
  { weight: 3, arbitrary: writes('device', ['insert', 'update', 'delete'], 3) },
  { weight: 2, arbitrary: fc.constant({ kind: 'upload' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'export' as const }) },
  { weight: 1, arbitrary: fc.constantFrom(...(['truncate', 'backup', 'restore'] as const).map((kind) => ({ kind }))) },
);

/**
 * What the destination does on each exporter call, in order (none once exhausted): fail reading its position, fail and roll back the
 * write, commit the write and then fail (the response is lost), or let the scenario's next write or truncation land while it is awaited.
 */
type Fault = 'none' | 'position' | 'rollback' | 'lost' | 'interleave';
const fault = fc.constantFrom<Fault>('none', 'none', 'position', 'rollback', 'lost', 'interleave');

type Scenario = { pools: Pools; steps: Step[]; faults: Fault[]; ticks: number[]; limit: number; budget: number };

const scenario: fc.Arbitrary<Scenario> = fc.record({
  pools,
  steps: fc.array(step, { minLength: 4, maxLength: 40, size: 'medium' }),
  faults: fc.array(fault, { maxLength: 40, size: 'medium' }),
  // Milliseconds each destination write takes, against a per-alarm budget, so runs end mid-export and resume.
  ticks: fc.array(fc.nat(60), { minLength: 1, maxLength: 10 }),
  // Characters per chunk: tiny limits end chunks inside commits and even after a single op.
  limit: fc.oneof(fc.integer({ min: 1, max: 400 }), fc.constant(500_000)),
  budget: fc.integer({ min: 1, max: 150 }),
});

const keyOf = (spec: Spec, key: Record<string, unknown>) =>
  and(
    ...spec.key.map((column) => eq((getTableColumns(spec.table) as Record<string, SQLiteColumn>)[column] as SQLiteColumn, key[column])),
  ) as SQL;

const keyIn = (pools: Pools, { table, slot }: RowWrite) => pools[table]?.[slot % (pools[table]?.length ?? 1)] as Record<string, unknown>;

/** Runs a device transaction; a write the device refuses (invalid value, duplicate key) rolls the whole transaction back. */
const deviceWrite = (device: Device, pools: Pools, writes: RowWrite[]) =>
  failure(() =>
    write(device, async (tx) => {
      for (const one of writes) {
        const spec = specs[one.table] as Spec;
        const key = keyIn(pools, one);
        const target = spec.table as typeof item;
        if (one.how === 'insert') await tx.insert(target).values({ ...one.values, ...key } as never);
        else if (one.how === 'update')
          await tx
            .update(target)
            .set(one.values as never)
            .where(keyOf(spec, key));
        else await tx.delete(target).where(keyOf(spec, key));
      }
    }),
  );

/** Runs a server write; one the space refuses rolls back entirely and returns no poke. */
function serverWrite(space: Space, pools: Pools, writes: RowWrite[]) {
  try {
    return space.mutate((tx) => {
      for (const one of writes) {
        const target = (specs[one.table] as Spec).table as SQLiteTable;
        if (one.how === 'delete') tx.delete(target, keyIn(pools, one) as never);
        else tx[one.how](target, { ...one.values, ...keyIn(pools, one) } as never);
      }
    });
  } catch {
    return undefined;
  }
}

/** Destination failure injected by a test. */
class Refused extends Error {}

/** Clock read by the export budget: the destination advances it as it writes. */
let clock = 0;
afterEach(() => {
  vi.restoreAllMocks();
});

/** A scenario being played: cloud state, the destination, and what the exporter contract lets each delivered chunk be. */
class Play {
  readonly #scenario: Scenario;
  readonly queue: Step[];
  storage: Storage;
  space: Space;
  device: Device;
  readonly replica = new Replica();
  readonly exports: Exports;
  #backup: Uint8Array | undefined;
  /** Count of changes to cloud state: a chunk redelivered after a rolled back write is identical only while it stays put. */
  #changes = 0;
  /** Count of truncations and recoveries, the only ways the history a position refers to goes away. */
  #cuts = 0;
  /** Cuts counted when the chunk whose next the replica saved was read: resets come only from history cut later. */
  #savedAt = 0;
  #rolledBack: { chunk: Chunk; changes: number } | undefined;
  #calls = 0;
  interleaved = false;

  constructor(scenario: Scenario, { storage, space, device }: Awaited<ReturnType<typeof cloud>>) {
    this.#scenario = scenario;
    this.queue = [...scenario.steps];
    this.storage = storage;
    this.space = space;
    this.device = device;
    const exporter: Exporter = { position: () => this.#position(), write: (chunk) => this.#deliver(chunk) };
    this.exports = exportsTo(() => this.space, exporter, scenario.limit, scenario.budget);
  }

  async perform(next: Step) {
    if (next.kind === 'export') return this.drain();
    this.#changes += 1;
    if ('writes' in next) await this.#write(next.kind, next.writes);
    else if (next.kind === 'backup') this.#backup = this.storage.image();
    else if (next.kind === 'restore') await this.#restore();
    else if (next.kind === 'truncate') {
      this.#cuts += 1;
      while (this.space.truncate());
    } else await upload(this.space, this.device, [this.device]);
  }

  async #write(by: 'server' | 'device', writes: RowWrite[]) {
    if (by === 'device') {
      await deviceWrite(this.device, this.#scenario.pools, writes);
      return;
    }
    const poke = serverWrite(this.space, this.#scenario.pools, writes);
    if (poke) await this.device.private.receive(poke);
  }

  async #restore() {
    if (!this.#backup) return;
    this.#cuts += 1;
    this.device.close();
    ({ storage: this.storage, space: this.space, device: this.device } = await cloud(restoredStorage(this.#backup)));
  }

  /** Runs export alarms until one finishes caught up, retrying failed runs as backoff would. */
  async drain() {
    this.interleaved = false;
    for (let run = 0; run < 5_000; run += 1) {
      try {
        if (!(await chore(this.exports, clock).run())) {
          // Caught up: unless a write landed while the destination was awaited, the replica holds exactly the cloud's rows.
          if (!this.interleaved) expect(stored(this.replica.storage)).toEqual(stored(this.storage));
          return;
        }
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
      }
    }
    throw new Error('export never caught up');
  }

  #fault() {
    return this.#scenario.faults[this.#calls++] ?? 'none';
  }

  async #position() {
    if (this.#fault() === 'position') throw new Refused('position');
    return this.replica.position();
  }

  async #deliver(chunk: Chunk) {
    const fault = this.#fault();
    const read = this.#cuts;
    const { ticks } = this.#scenario;
    clock += ticks[this.#calls % ticks.length] ?? 0;
    const next = this.queue[0];
    // A recovery restarts the object, ending the alarm run, so any other step but an export can land while the destination is awaited.
    if (fault === 'interleave' && next && next.kind !== 'export' && next.kind !== 'restore') {
      this.interleaved = true;
      await this.perform(this.queue.shift() as Step);
    }
    this.#check(chunk);
    const written = this.replica.write(chunk, () => {
      if (fault !== 'rollback') return;
      this.#rolledBack = { chunk, changes: this.#changes };
      throw new Refused('rollback');
    });
    if (written) this.#savedAt = read;
    if (fault === 'lost') throw new Refused('lost');
  }

  /** Checks a delivered chunk against the exporter contract. */
  #check(chunk: Chunk) {
    // A first export is a full snapshot starting with clear, not marked reset.
    if (chunk.from === undefined) expect([chunk.reset, chunk.patch[0]]).toEqual([false, { op: 'clear' }]);
    // Resuming from a stored position yields a fresh snapshot only when that position left the history, and then marks it reset.
    expect(chunk.reset).toBe(chunk.from !== undefined && chunk.patch[0]?.op === 'clear');
    if (chunk.reset) expect(this.#cuts).toBeGreaterThan(this.#savedAt);
    // A failed write gets the identical chunk next time, as long as the cloud has not changed since.
    if (this.#rolledBack && this.#rolledBack.changes === this.#changes) expect(chunk).toEqual(this.#rolledBack.chunk);
    this.#rolledBack = undefined;
  }
}

/** Plays a scenario, then uploads what the device still holds and exports until caught up. */
async function play(scenario: Scenario) {
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const played = new Play(scenario, await cloud(created()));
  try {
    while (played.queue.length > 0) await played.perform(played.queue.shift() as Step);
    await upload(played.space, played.device, [played.device]);
    await played.drain();
    expect(stored(played.replica.storage)).toEqual(stored(played.storage));
  } finally {
    played.device.close();
  }
}

test('an exporter replica ends with exactly the cloud rows through destination failures, budget cuts, tiny chunks, interleaved writes, truncation, and point-in-time recovery', async () => {
  await fc.assert(fc.asyncProperty(scenario, play), { numRuns: 150, interruptAfterTimeLimit: 10_000 });
});
