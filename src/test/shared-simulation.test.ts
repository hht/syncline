import { drizzle } from 'drizzle-orm/durable-sqlite';
import { expect, test } from 'vitest';
import { formatCookie } from '../common/protocol.ts';
import { Device } from '../test/test-device.ts';
import { Network } from './test-network.ts';
import { random } from './test-random.ts';
import { garbled } from './test-requests.ts';
import {
  bucketsOf,
  createProgram,
  program,
  type Row,
  rowsOf,
  SharedCloud,
  subscriptionNames,
  subscriptionOf,
} from './test-shared-cloud.ts';
import { type Seen, SharedTracer, type Version } from './test-shared-trace.ts';
import { picker, settle, simulated, started, takeStep } from './test-skeleton.ts';
import { deviceStorage } from './test-storage.ts';
import type { Connection } from './test-sync.ts';
import type { Message } from './test-trace.ts';

// Shared space deterministic simulation: a random seed dictates server writes, network message ordering, timers, and faults.
// Runs the actual Space (shared space), Broadcast, and device-side Rust shared space mirror and Connection;
// token, WebSocket, HTTP, and timers are replaced with test doubles, and HTTP pulls traverse a mock edge cache.
// Edge cache returns stale cached copies when URLs match (responses computed before floor are never cached, matching cacheControl).
// Faults: disconnects, silent disconnects, request failures, corrupted payloads, dropped fanout notices (retried with backoff via production fanout),
// broadcast shard restarts (disconnects all), hibernated eviction (loses in-memory state while sockets stay open), bucket rule evolution on deploy,
// shared space rebuilds (shards may retain newer notices, device cookies off history; omitted during trace validation),
// and device crashes, backgrounding, and user logout/login (clearing previous user rows).
// Asserts model/Shared.tla invariants: local rows match the landed subscription at the cookie version under that version's bucket rules.
// Once faults stop, all devices catch up to cloud head; background bucket count upkeep matches visible row counts per bucket.
// Stale intermediate chunks are covered by dedicated unit tests and the model.
// @see https://apple.github.io/foundationdb/testing.html

const url = 'https://sync.test/catalog';
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** Formats subscription name into model bucket names (TraceShared.tla): ['team', 'a'] becomes 'team.a'; empty when undefined. */
const bucketNames = (name: string | undefined) => (name === undefined ? [] : bucketsOf(name).map((bucket) => bucket.join('.')));
/** Resolves subscription name from digest hash. */
const nameOf = (sub: string | undefined) => subscriptionNames.find((name) => subscriptionOf(name).sub === sub);

class SharedSimulation {
  readonly #random: () => number;
  readonly #pick: ReturnType<typeof picker>;
  readonly #network: Network;
  /** Cloud: shared space, broadcast shards, and mock edge cache. */
  readonly #cloud: SharedCloud;
  /** Expected visible rows for each subscription and version cookie under that version's bucket rules. */
  readonly #history = new Map<string, Row[]>();
  readonly #storages = [0, 1, 2].map(() => deviceStorage(createProgram));
  /** Active owner logged into each device: switching owners clears previously visible rows. */
  readonly owners: string[] = [];
  readonly #devices: Device[] = [];
  readonly mirrors: ReturnType<Device['shared']>[] = [];
  readonly #connections: Connection[] = [];
  /** Devices whose token changed but integrator has not yet called reconnect(). */
  readonly #late = new Set<number>();
  /** One tracer per device during trace validation; undefined otherwise. */
  readonly tracer: SharedTracer | undefined;

  constructor(seed: number, tracer?: SharedTracer) {
    this.#random = random(seed);
    this.#pick = picker(this.#random);
    this.tracer = tracer;
    this.#network = new Network(
      (items) => this.#pick(items),
      () => this.#cloud.endpoint,
    );
    this.#network.trace = tracer && ((name, index, options) => this.#traced(tracer, name, index, options ?? {}));
    this.#cloud = new SharedCloud(this.#network, this.#random, []);
    this.#record();
    for (const index of this.#storages.keys()) this.#start(index, this.#pick(subscriptionNames) as string);
  }

  /**
   * Maps network events to model actions in model/Shared.tla: initial shard message is Connect, subsequent are Push;
   * delivered messages are Deliver; pull responses are PullDone (tracking version and subscription); pull requests are PullStart;
   * failed pulls are PullLost; disconnecting open connections is Disconnect.
   */
  #traced(
    tracer: SharedTracer,
    name: string,
    index: number,
    { message, first, opened }: { message?: Message; first?: boolean; opened?: boolean },
  ) {
    const pulled = message && ['pullreq', 'pullresp', 'chunk', 'reset'].includes(message.t);
    if (name === 'Sent') tracer.add(index, first ? 'Connect' : 'Push', { ...(message && { message }) });
    else if (name === 'Recv' && pulled)
      tracer.add(index, 'PullDone', { ...(message && { message }), sub: bucketNames(nameOf(message.sub)) });
    else if (name === 'Recv') tracer.add(index, 'Deliver', { ...(message && { message }) });
    else if (name === 'PullReq') tracer.add(index, 'PullStart');
    else if (name === 'Drop' && pulled) tracer.add(index, 'PullLost');
    else if (name === 'Disconnect' && opened) tracer.add(index, 'Disconnect');
  }

  storage(index: number) {
    return this.#storages[index] as ReturnType<typeof deviceStorage>;
  }

  /**
   * Device startup (crash recovery, user login): new Device, shared space mirror, and Connection for owner; closes previous sockets.
   * Initial launch corresponds to Init; crash recovery of same user corresponds to Crash; switching users is omitted during trace validation.
   */
  #start(index: number, owner: string) {
    if (this.owners[index] === undefined) this.tracer?.begin(index, bucketNames(owner));
    else if (this.owners[index] === owner) this.tracer?.add(index, 'Crash');
    this.#connections[index]?.stop();
    this.#devices[index]?.close();
    this.#network.disconnect(index);
    // Same user restarting: acquires same token as before crash (may have resubscribed prior).
    if (this.owners[index] !== owner) this.#cloud.subscriptions[index] = owner;
    const device = new Device(this.storage(index), []);
    const mirror = device.shared('catalog', [program], owner);
    this.#devices[index] = device;
    this.mirrors[index] = mirror;
    this.owners[index] = owner;
    this.#connections[index] = started(mirror, `${url}/${index}`, this.#network, index, this.#random);
  }

  /** Enters background then returns: closes connection and cancels in-flight pulls. */
  #background(index: number) {
    this.#connections[index]?.stop();
    this.#connections[index]?.start();
  }

  /**
   * Device token change (SubChange in model/Shared.tla): future pulls and new connections evaluate under new token;
   * half of occurrences call reconnect() immediately, while the rest delay reconnect() until after a pull lands the new subscription.
   */
  #resubscribe(index: number) {
    const before = this.#cloud.subscriptions[index];
    this.#cloud.resubscribe(index);
    const after = this.#cloud.subscriptions[index] as string;
    if (after !== before) this.tracer?.add(index, 'SubChange', { sub: bucketNames(after) });
    if (this.#random() < 0.5) this.#connections[index]?.reconnect();
    else this.#late.add(index);
  }

  /** Integrator delayed reconnect(): triggers reconnect on a pending device. */
  #reconnectLate() {
    const index = this.#pick([...this.#late]) as number;
    this.#late.delete(index);
    this.#connections[index]?.reconnect();
  }

  async step() {
    const device = Math.floor(this.#random() * this.#storages.length);
    const actions: [number, () => unknown][] = [
      [10, () => this.#cloud.write()],
      [this.#cloud.lagging() ? 6 : 0, () => this.#cloud.deliver()],
      [2, () => this.#cloud.deploy()],
      [2, () => this.#cloud.restartShard()],
      [2, () => this.#cloud.evictShard()],
      [this.tracer ? 0 : 1, () => this.#cloud.rebuild()],
      [this.tracer ? 0 : 4, () => this.#cloud.count()],
      [this.tracer ? 0 : 2, () => this.#cloud.truncate()],
      [60, () => this.#network.deliver()],
      [12, () => this.#network.handshake()],
      [12, () => this.#network.respond()],
      [12, () => this.#network.arrive()],
      [10, () => this.#network.fire()],
      [6, () => this.#network.breakOne()],
      [3, () => this.#network.silenceOne()],
      [3, () => this.#network.failOne()],
      [2, () => this.#network.garbleOne()],
      [3, () => this.#start(device, this.owners[device] as string)],
      // Backgrounding and returning: stops then restarts existing Connection.
      [3, () => this.#background(device)],
      [this.tracer ? 0 : 2, () => this.#start(device, this.#pick(subscriptionNames) as string)],
      [6, () => this.#resubscribe(device)],
      [this.#late.size > 0 ? 3 : 0, () => this.#reconnectLate()],
    ];
    await takeStep(this.#pick, actions, this.tracer, () => this.#after());
  }

  async settle() {
    this.#cloud.calm();
    while (this.#late.size > 0) this.#reconnectLate();
    await this.#after();
    await settle({
      network: this.#network,
      pick: this.#pick,
      tracer: this.tracer,
      converged: () => this.#converged(),
      after: () => this.#after(),
    });
    this.#cloud.checkCounts();
  }

  /**
   * Convergence (S2 in model/Shared.tla): all devices caught up to head, matching current cloud incarnation,
   * landed current token subscription, and local rows match cloud visible rows for that subscription.
   */
  #converged() {
    return this.mirrors.every((mirror, index) => {
      const name = this.#cloud.subscriptions[index] as string;
      const [row] = this.storage(index).sql.exec("SELECT incarnation FROM _syncline_cookie WHERE space = 'catalog'").toArray();
      return (
        !mirror.behind() &&
        row?.incarnation === this.#cloud.incarnation() &&
        this.#landed(index) === name &&
        JSON.stringify(this.rows(index)) === JSON.stringify(this.#visible(name))
      );
    });
  }

  /** Subscription name landed on device index; undefined if not yet synced. */
  #landed(index: number) {
    const [row] = this.storage(index).sql.exec("SELECT sub FROM _syncline_cookie WHERE space = 'catalog'").toArray();
    return subscriptionNames.find((name) => subscriptionOf(name).sub === row?.sub);
  }

  /** Visible rows for given subscription name in current cloud state. */
  #visible(name: string) {
    return rowsOf(this.#cloud.storage, this.#cloud.definition(), bucketsOf(name));
  }

  /** Rows on device at index. */
  rows(index: number) {
    return drizzle(this.storage(index)).select().from(program).orderBy(program.id).all();
  }

  /** Records visible rows for each subscription at cloud head under current bucket rules. */
  #record() {
    for (const name of subscriptionNames) {
      const key = `${name}:${formatCookie(this.#cloud.head())}`;
      if (!this.#history.has(key)) this.#history.set(key, this.#visible(name));
    }
  }

  async #after() {
    await flush();
    this.#observe();
    this.#record();
    // Asserts Consistent from model/Shared.tla: local rows match landed subscription at cookie version.
    for (const [index, mirror] of this.mirrors.entries()) {
      const cookie = mirror.cookie();
      const landed = this.#landed(index);
      const expected = cookie ? this.#history.get(`${landed}:${formatCookie(cookie)}`) : [];
      if (!expected) throw new Error(`device ${index} cookie is not an emitted version: ${JSON.stringify(cookie)} (${landed})`);
      expect(this.rows(index), `device ${index} (${landed}) at ${cookie?.version ?? 'not synced'}`).toEqual(expected);
      if (this.#network.live(index) > 1) throw new Error(`device ${index} has ${this.#network.live(index)} concurrent active connections`);
    }
  }

  close() {
    for (const connection of this.#connections) connection.stop();
  }

  /**
   * Trace validation observation: records newly emitted versions since last check (mutated row and bucket column,
   * or rule changes without keys) alongside visible state across devices.
   */
  #observe() {
    if (!this.tracer) return;
    const versions = this.#cloud.storage.sql
      .exec('SELECT keys FROM _syncline_commit WHERE version > ? ORDER BY version', this.tracer.head)
      .toArray()
      .map(({ keys }): Version => {
        const entries = JSON.parse(String(keys)) as [string, { id: string }][];
        const [entry, ...rest] = entries;
        if (rest.length > 0) throw new Error(`version touched ${entries.length} rows; tracer only models single-row writes`);
        return entry ? { k: entry[1].id, c: this.#cloud.bucketColumn(entry[1].id) } : { c: 0 };
      });
    const seen = this.mirrors.map(
      (mirror, index): Seen => ({
        cookie: mirror.cookie()?.version ?? -1,
        staged: Number(this.storage(index).sql.exec("SELECT count(*) AS n FROM _syncline_stage WHERE space = 'catalog'").toArray()[0]?.n),
        landed: bucketNames(this.#landed(index)),
        sub: bucketNames(this.#cloud.subscriptions[index]),
      }),
    );
    this.tracer.observe(versions, seen, this.#cloud.head().version);
  }
}

test.for(Array.from({ length: 100 }, (_, index) => Number(process.env.SIMULATION_SEED ?? 0) + index))(
  'shared space seed %i: converges across disconnects, stale cache, dropped fanout, shard restarts, rule changes, and token updates',
  async (seed) => {
    // When SIMULATION_TRACE directory is set, records device traces for verification by model/TraceShared.tla (pnpm model:trace).
    const traces = process.env.SIMULATION_TRACE;
    await simulated(
      () => new SharedSimulation(seed, traces ? new SharedTracer(3) : undefined),
      (simulation) => {
        simulation.close();
        if (traces) simulation.tracer?.write(traces, seed);
      },
      (message) => message.includes(garbled),
    );
  },
);
