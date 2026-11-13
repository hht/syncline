import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Subscribed } from '../../src/cloud/shared.ts';
import type { Cookie } from '../../src/common/protocol.ts';
import { random, stepped } from '../support/test-random.ts';
import { RecordingSocket } from '../support/test-sockets.ts';
import { cookieOf, FanoutCloud, incarnation, pick, shardNames, type Weighted, when } from './test-fanout.ts';

// Fanout simulation: a random seed picks the actions of model/Fanout.tla (backend writes, keyless writes, rounds reaching a shard after
// later writes, with or without their acknowledgment, rounds lost on the way, sends timing out while the shard still processes them, shard
// queries answering late or failing, shard resets, shared space restarts, a device connecting, disconnecting, reading messages, and pulling)
// and drives the real Fanout and two real Broadcast shards with them. The resident device stays connected to the first shard. After every
// message a connection receives, it must chain onto the previous one and carry every row of its buckets in between (Covers, Complete),
// versions must only grow, and no hint may name a version past head (NoWastedPull); a final phase without writes or faults checks both
// devices reach their relevant head (CatchesUp).
// Left to other tests: incarnations other than one (space rebuilds), changing the shard set, and rounds the fanout gave up on arriving late
// with tokens expiring.
// @see https://apple.github.io/foundationdb/testing.html

/** Subscriptions of the device and of the resident device. */
const deviceSub: Subscribed = { subscription: ['b1'], sub: 'sub-b1' };
const residentSub: Subscribed = { subscription: ['b2'], sub: 'sub-b2' };
const maxConns = 3;

let clock = 0;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.stubGlobal('reportError', () => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Lets every settled promise run its continuations. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type Message = { base?: Cookie; hint?: Cookie; cookie?: Cookie; patch?: { key: { v: number } }[]; incarnation: number; sub: string };

/** A connection as its device sees it: messages are readable once the shard accepted it (the 101 response). */
type Connection = { shard: string; socket: RecordingSocket; accepted: boolean; read: number; cookie: Cookie; previous?: Cookie };

class Simulation {
  readonly steps: string[] = [];
  readonly #random: () => number;
  readonly #cloud: FanoutCloud;
  #conns = 0;
  /** The device: cookie, target version from hints, pull in flight (its floor), rows it holds (by version), and its connection. */
  #cookie = 0;
  #want = 0;
  #inflight: number | undefined;
  #rows = new Set<number>();
  #connection: Connection | undefined;
  readonly #resident: Connection = {
    shard: shardNames[0] as string,
    socket: new RecordingSocket(),
    accepted: false,
    read: 0,
    cookie: cookieOf(0),
  };
  /** Highest version the resident device heard of. */
  #seen = 0;

  constructor(seed: number) {
    this.#random = random(seed);
    clock = 1_000_000;
    // A shard resetting while it accepts a connection fails the device's connection attempt
    this.#cloud = new FanoutCloud(this.steps, this.#random, (shard) => {
      if (this.#connection?.shard === shard && !this.#connection.accepted) this.#drop();
    });
  }

  /** Connects the resident device and answers its catch-up query before any action runs. */
  async init() {
    const resident = this.#resident;
    void this.#cloud.connect(resident.shard, resident.socket, resident.cookie, residentSub).then(() => {
      resident.accepted = true;
    });
    this.#cloud.answer(resident.shard, true);
    await flush();
    this.steps.length = 0;
    this.check();
  }

  #pick<T>(items: readonly T[]) {
    return pick(this.#random, items);
  }

  /** Device actions enabled now; `faults` lets the device drop its connection while it has connections left. */
  #actions(faults: boolean): Weighted[] {
    const connection = this.#connection;
    const unread = connection?.accepted && connection.read < connection.socket.sent.length;
    return [
      [when(!connection && (!faults || this.#conns < maxConns), 2), () => this.#connect(this.#pick(shardNames))],
      [when(faults && connection && this.#conns < maxConns, 1), () => this.#disconnect('disconnect')],
      // A device hearing nothing on a new connection within its catch-up deadline gives up on it: a shard whose catch-up query fails
      // while it knows no round sends nothing
      [when(connection?.accepted && connection.socket.sent.length === 0, 1), () => this.#disconnect('no catch-up')],
      [when(unread, 4), () => this.#deliver()],
      [when(this.#inflight === undefined && this.#want > this.#cookie, 2), () => this.#pullStart()],
      [when(this.#inflight !== undefined, 2), () => this.#pullDone(faults)],
      // Lets the shards' cached answers to the latest round expire
      [1, () => this.#tick()],
    ];
  }

  /** Takes one enabled action, if any, then checks every connection. */
  async step(faults: boolean) {
    const actions = [...this.#cloud.actions(faults), ...this.#actions(faults)];
    const enabled = actions.flatMap(([weight, action]) => Array<() => void>(weight).fill(action));
    if (enabled.length === 0) return;
    this.#pick(enabled)();
    await flush();
    this.check();
  }

  #connect(shard: string) {
    this.#conns += 1;
    const connection: Connection = { shard, socket: new RecordingSocket(), accepted: false, read: 0, cookie: cookieOf(this.#cookie) };
    this.#connection = connection;
    this.steps.push(`connect ${shard} at v${this.#cookie}`);
    void this.#cloud.connect(shard, connection.socket, connection.cookie, deviceSub).then(() => {
      connection.accepted = true;
    });
  }

  #disconnect(why: string) {
    this.steps.push(why);
    this.#drop();
  }

  /** Closes the device's connection: unread messages are lost, and the shard stops pushing to the socket. */
  #drop() {
    const connection = this.#connection;
    if (!connection) return;
    connection.socket.readyState = WebSocket.CLOSED;
    this.#connection = undefined;
  }

  /** The device reads its next message: lands a notice chaining onto its cookie, or records the target version. */
  #deliver() {
    const connection = this.#connection as Connection;
    const message = this.#read(connection, deviceSub);
    const cookie = (message.cookie ?? message.hint) as Cookie;
    this.steps.push(`deliver ${message.patch ? `notice (${message.base?.version}, ${cookie.version}]` : `hint v${cookie.version}`}`);
    if (message.patch && this.#inflight === undefined && message.base?.version === this.#cookie) {
      for (const { key } of message.patch) this.#rows.add(key.v);
      this.#cookie = cookie.version;
    } else this.#want = Math.max(this.#want, cookie.version);
  }

  #tick() {
    this.steps.push('tick');
    clock += 6000;
  }

  #pullStart() {
    this.steps.push(`pull from v${this.#want}`);
    this.#inflight = this.#want;
  }

  /** A pull lands a response computed at or after its floor (cached responses included); the fair final phase always reaches head. */
  #pullDone(faults: boolean) {
    const floor = this.#inflight as number;
    const head = this.#cloud.head;
    const at = faults ? floor + Math.floor(this.#random() * (head - floor + 1)) : head;
    this.steps.push(`pulled v${at}`);
    this.#inflight = undefined;
    this.#cookie = Math.max(this.#cookie, at);
    this.#rows = new Set(this.#cloud.rows(0, this.#cookie, deviceSub));
  }

  /** Reads the next message of a connection, checking it against everything the connection received before. */
  #read(connection: Connection, subscribed: Subscribed) {
    const message = JSON.parse(connection.socket.sent[connection.read] ?? '') as Message;
    connection.read += 1;
    const cookie = (message.cookie ?? message.hint) as Cookie;
    const at = `${connection.shard} message ${connection.read}`;
    expect({ at, incarnation: message.incarnation, sub: message.sub, cookie }).toEqual({
      at,
      incarnation,
      sub: subscribed.sub,
      cookie: cookieOf(cookie.version),
    });
    // Versions only grow on a connection, and a hint never names a version past head
    const grows = !connection.previous || cookie.version > connection.previous.version;
    expect({ at, grows, beyond: cookie.version > this.#cloud.head }).toEqual({ at, grows: true, beyond: false });
    if (message.patch) this.#covers(at, connection, message, subscribed);
    connection.previous = cookie;
    return message;
  }

  /**
   * Checks a notice chains onto the previous message (the first one is an empty catch-up at the device's cookie), spans no keyless
   * version, and carries every row of the connection's buckets in between; a round starting before the connection's last message repeats
   * rows the device already holds, which only rewrites them with their current values.
   */
  #covers(at: string, connection: Connection, message: Message, subscribed: Subscribed) {
    const base = message.base as Cookie;
    const cookie = message.cookie as Cookie;
    expect({ at, base }).toEqual({ at, base: connection.previous ?? connection.cookie });
    if (!connection.previous) expect({ at, patch: message.patch, cookie }).toEqual({ at, patch: [], cookie: connection.cookie });
    const rows = message.patch?.map(({ key }) => key.v) ?? [];
    const relevant = this.#cloud.relevant(0, cookie.version, subscribed);
    expect({
      at,
      wide: this.#cloud.relevant(base.version, cookie.version, subscribed).filter((v) => this.#cloud.wide(v)),
      missing: this.#cloud.rows(base.version, cookie.version, subscribed).filter((v) => !rows.includes(v)),
      foreign: rows.filter((v) => !relevant.includes(v)),
    }).toEqual({ at, wide: [], missing: [], foreign: [] });
  }

  check() {
    const resident = this.#resident;
    while (resident.read < resident.socket.sent.length) {
      const message = this.#read(resident, residentSub);
      this.#seen = Math.max(this.#seen, ((message.cookie ?? message.hint) as Cookie).version);
    }
    // The device holds exactly the rows of its buckets up to its cookie
    expect(this.#rows).toEqual(new Set(this.#cloud.rows(0, this.#cookie, deviceSub)));
    expect(this.#want).toBeLessThanOrEqual(this.#cloud.head);
  }

  /** Both devices' versions against their relevant heads, and whether both reached them. */
  status() {
    const relevant = (subscribed: Subscribed) => this.#cloud.relevant(0, this.#cloud.head, subscribed).at(-1) ?? 0;
    const heads = { device: relevant(deviceSub), resident: relevant(residentSub) };
    return { cookie: this.#cookie, seen: this.#seen, ...heads, caughtUp: this.#cookie >= heads.device && this.#seen >= heads.resident };
  }
}

test.for(Array.from({ length: 500 }, (_, index) => index))(
  'fanout simulation seed %i: every connection receives chained notices covering its buckets, and both devices catch up',
  async (seed) => {
    const simulation = new Simulation(seed);
    await simulation.init();
    await stepped(seed, simulation.steps, async () => {
      for (let step = 0; step < 60; step++) await simulation.step(true);
      // No more writes or faults: the fair actions alone bring both devices to their relevant head
      for (let step = 0; step < 300 && !simulation.status().caughtUp; step++) await simulation.step(false);
      expect(simulation.status()).toMatchObject({ caughtUp: true });
    });
  },
);
