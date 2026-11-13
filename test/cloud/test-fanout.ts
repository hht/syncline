import { Broadcast } from '../../src/cloud/broadcast.ts';
import { type Confirmed, Fanout } from '../../src/cloud/fanout.ts';
import type { Round, Subscribed } from '../../src/cloud/shared.ts';
import type { Cookie } from '../../src/common/protocol.ts';
import type { RecordingSocket } from '../support/test-sockets.ts';

// The cloud side of the fanout simulation: a shared space history, the real Fanout delivering it, and two real Broadcast shards, with
// every delivery, acknowledgment, and shard query held until an action of the simulation releases or fails it.

export const incarnation = 7;
const buckets = ['b1', 'b2'];
export const shardNames = ['s#0', 's#1'];
const maxWrites = 8;
const maxFaults = 4;

export const cookieOf = (version: number): Cookie => ({ version, nonce: version * 31 + 1 });

/** An action with its weight: 0 when disabled. */
export type Weighted = [number, () => void];

/** An action's weight: `weight` when enabled, else 0. */
export const when = (enabled: unknown, weight: number) => (enabled ? weight : 0);

/** Picks one of `items` with `random`. */
export const pick = <T>(random: () => number, items: readonly T[]) => items[Math.floor(random() * items.length)] as T;

type Deferred<T> = { resolve: (value: T) => void; reject: (error: Error) => void };
/** A round the fanout sent: waiting to reach the shard, or arrived (the shard processes it) and not yet answered. */
type Send = Deferred<void> & { shard: string; round: Round; arrived?: number };

const range = ({ round }: Send) => `(${round.base.version}, ${round.cookie.version}]`;

class Shard {
  readonly sockets: RecordingSocket[] = [];
  /** Incarnation of the in-memory shard: a reset starts a new one, and the old one's pending query never answers. */
  epoch = 0;
  query: Deferred<Round> | undefined;
  broadcast!: Broadcast<RecordingSocket>;

  constructor() {
    this.start();
  }

  start() {
    this.epoch += 1;
    this.query = undefined;
    const epoch = this.epoch;
    const sockets = { acceptWebSocket: (socket: RecordingSocket) => this.sockets.push(socket), getWebSockets: () => this.sockets };
    const latest = () =>
      new Promise<Round>((resolve, reject) => {
        if (this.epoch === epoch) this.query = { resolve, reject };
      });
    this.broadcast = new Broadcast(sockets, latest);
  }
}

export class FanoutCloud {
  readonly #steps: string[];
  readonly #random: () => number;
  /** Called when a shard resets, before it starts again. */
  readonly #reset: (shard: string) => void;
  /** History: buckets touched by each version (index 0 is the initial version), and versions without keys (rule changes, rebuilds). */
  readonly #touched: string[][] = [[]];
  readonly #wide: boolean[] = [false];
  #persisted: Confirmed | null = null;
  #fanout: Fanout;
  readonly #shards = new Map(shardNames.map((name) => [name, new Shard()]));
  #sends: Send[] = [];
  #faults = 0;

  constructor(steps: string[], random: () => number, reset: (shard: string) => void) {
    this.#steps = steps;
    this.#random = random;
    this.#reset = reset;
    this.#fanout = this.#start();
  }

  get head() {
    return this.#touched.length - 1;
  }

  /** Versions in `(from, to]` touching `subscription`, or keyless. */
  relevant(from: number, to: number, { subscription }: Subscribed) {
    const versions: number[] = [];
    for (let v = from + 1; v <= to; v++)
      if (this.#wide[v] || (this.#touched[v] ?? []).some((bucket) => subscription.includes(bucket))) versions.push(v);
    return versions;
  }

  /** Versions in `(from, to]` carrying rows of `subscription`'s buckets. */
  rows(from: number, to: number, subscribed: Subscribed) {
    return this.relevant(from, to, subscribed).filter((v) => !this.#wide[v]);
  }

  wide(v: number) {
    return this.#wide[v] === true;
  }

  /** Connects a socket to a shard as a device with `cookie`; resolves once the shard accepted it. */
  connect(shard: string, socket: RecordingSocket, cookie: Cookie, subscribed: Subscribed) {
    return this.#shard(shard).broadcast.accept(socket, cookie, Number.MAX_SAFE_INTEGER, subscribed);
  }

  #pick<T>(items: readonly T[]) {
    return pick(this.#random, items);
  }

  #shard(name: string) {
    const shard = this.#shards.get(name);
    if (!shard) throw new Error(`No shard ${name}`);
    return shard;
  }

  /** Starts the shared space's fanout from what it persisted. */
  #start() {
    return new Fanout(
      {
        shards: shardNames,
        head: () => cookieOf(this.head),
        round: (from, head) => this.#round(from ?? head, head),
        send: (shard, round) =>
          new Promise<void>((resolve, reject) => {
            this.#sends.push({ shard, round, resolve, reject });
          }),
        failed: () => undefined,
        confirmed: (state) => {
          this.#persisted = state;
        },
      },
      this.#persisted,
    );
  }

  /** Builds the round from `base` to `head`: one row per version, or none when a version has no keys or the round is too large. */
  #round(base: Cookie, head: Cookie): Round {
    const versions = Array.from({ length: head.version - base.version }, (_, index) => base.version + 1 + index);
    const many = versions.some((v) => this.#wide[v]) || this.#random() < 0.15;
    const rows = versions.map((v) => {
      const touched = this.#touched[v] ?? [];
      return { table: 't', key: { v }, row: { v }, now: touched, touched };
    });
    return { base, cookie: head, incarnation, ...(!many && { rows }) };
  }

  /** Actions enabled now; `faults` adds writes and every fault. */
  actions(faults: boolean): Weighted[] {
    const fault = faults && this.#faults < maxFaults;
    const waiting = this.#sends.filter((send) => send.arrived === undefined);
    const arrived = this.#sends.filter((send) => send.arrived !== undefined);
    const queried = shardNames.filter((name) => this.#shard(name).query);
    const sending = waiting.length > 0;
    return [
      [when(faults && this.head < maxWrites, 3), () => this.#write()],
      [when(!this.#fanout.allAcked(), 1), () => this.#redeliver()],
      [when(sending, 4), () => this.#arrive(this.#pick(waiting), true)],
      [when(fault && sending, 1), () => this.#arrive(this.#pick(waiting), false)],
      [when(fault && sending, 1), () => this.#fail(this.#pick(waiting), 'lose')],
      [when(fault && arrived.length > 0, 1), () => this.#fail(this.#pick(arrived), 'timeout')],
      [when(queried.length > 0, 3), () => this.answer(this.#pick(queried), true)],
      [when(fault && queried.length > 0, 1), () => this.answer(this.#pick(queried), false)],
      [when(fault, 1), () => this.#resetShard(this.#pick(shardNames))],
      [when(fault, 1), () => this.#restart()],
    ];
  }

  /** A backend write touching some buckets, or a keyless version; the write delivers its round. */
  #write() {
    const wide = this.#random() < 0.15;
    const touched = wide ? [] : buckets.filter(() => this.#random() < 0.5);
    if (!wide && touched.length === 0) touched.push(this.#pick(buckets));
    this.#touched.push(touched);
    this.#wide.push(wide);
    this.#steps.push(`write v${this.head} ${wide ? 'wide' : touched.join('+')}`);
    void this.#fanout.deliver();
  }

  /** The alarm retrying delivery. */
  #redeliver() {
    this.#steps.push('redeliver');
    void this.#fanout.deliver();
  }

  /** A round reaches its shard, which processes it; `ack` says whether the acknowledgment reaches the shared space. */
  #arrive(send: Send, ack: boolean) {
    const shard = this.#shard(send.shard);
    send.arrived = shard.epoch;
    this.#steps.push(`arrive ${send.shard} ${range(send)}${send.round.rows ? '' : ' many'}${ack ? '' : ' unacked'}`);
    if (!ack) this.#faults += 1;
    shard.broadcast.notify(send.round).then(
      () => this.#settle(send, ack ? undefined : new Error('Acknowledgment lost')),
      (error: Error) => this.#settle(send, error),
    );
  }

  /** A round lost before reaching its shard, or a send timing out while its shard still processes the round. */
  #fail(send: Send, how: 'lose' | 'timeout') {
    this.#steps.push(`${how} ${send.shard} ${range(send)}`);
    this.#faults += 1;
    this.#settle(send, new Error(how));
  }

  #settle(send: Send, error: Error | undefined) {
    if (!this.#sends.includes(send)) return;
    this.#sends = this.#sends.filter((other) => other !== send);
    if (error) send.reject(error);
    else send.resolve();
  }

  /** The shared space answers (or fails) a shard's query for the latest round: an empty round at head. */
  answer(name: string, ok: boolean) {
    const shard = this.#shard(name);
    const query = shard.query;
    if (!query) return;
    shard.query = undefined;
    this.#steps.push(`${ok ? 'answer' : 'fail query'} ${name} at v${this.head}`);
    const head = cookieOf(this.head);
    if (ok) query.resolve({ base: head, cookie: head, incarnation, rows: [] });
    else {
      this.#faults += 1;
      query.reject(new Error('Shared space error'));
    }
  }

  /** A shard resets: memory is lost, hibernated sockets survive, and rounds it was processing fail. */
  #resetShard(name: string) {
    this.#steps.push(`reset ${name}`);
    this.#faults += 1;
    const shard = this.#shard(name);
    for (const send of this.#sends) if (send.shard === name && send.arrived === shard.epoch) this.#settle(send, new Error('Reset'));
    this.#reset(name);
    shard.start();
  }

  /** The shared space restarts: per-shard progress rolls back to what was persisted; rounds not yet arrived are gone. */
  #restart() {
    this.#steps.push('restart');
    this.#faults += 1;
    // The old fanout is gone: its sends never settle, so it never persists again; rounds that arrived still run in their shard.
    this.#sends = [];
    this.#fanout = this.#start();
    void this.#fanout.deliver();
  }
}
