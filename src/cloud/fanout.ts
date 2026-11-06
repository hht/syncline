import { type Cookie, sameCookie } from '../common/protocol.ts';
import type { Round } from './shared.ts';

/** Version acknowledged by all shards, with the shards that acknowledged it. */
export type Confirmed = { cookie: Cookie; shards: readonly string[] };

/** Host environment for fanout: shard list, head cookie, round builder, delivery, failure reporter, and confirmed version persistence. */
type Host = {
  shards: readonly string[];
  head: () => Cookie;
  /** Builds a round from `from` to `head` (`from` is null when no rounds have been sent yet; emits an empty round from `head` so shards learn the incarnation). */
  round: (from: Cookie | null, head: Cookie) => Round;
  /** Sends a round to a shard: resolving indicates delivery, throwing indicates failure. */
  send: (shard: string, round: Round) => Promise<void>;
  /** Reports a failed delivery to a shard. */
  failed: (shard: string, error: unknown) => void;
  /**
   * Called when all shards have confirmed through `head`: the persisted state is provided back to constructor on next startup.
   * Runs synchronously with all-shards-confirmed check to avoid race conditions with intervening writes; awaits returned promise.
   */
  confirmed: (state: Confirmed) => void | Promise<void>;
};

/**
 * Fans out shared-space head updates to all broadcast shards (following FanTo(s) in model/Fanout.tla, running independently per shard):
 * sends changes from each shard's last acknowledged version to head; advances only on successful delivery, leaving failures for retry;
 * limits in-flight traffic to at most one round per shard at a time, queuing at most one subsequent round (which samples head at send time,
 * including all commits prior to dispatch); stalled shards delay only themselves.
 * When all shards acknowledge the current head, notifies confirmed (for storage persistence) and advances baseline.
 * What this module should not know: shard implementation details, transport protocols, timeout thresholds, persistence storage mechanisms, or scheduling timers.
 */
export class Fanout {
  readonly #host: Host;
  /** Version acknowledged by all shards (persisted in storage; null if no round sent): a stale persisted version merely causes overlapping delivery that shards handle idempotently. */
  #confirmed: Cookie | null;
  /** Version acknowledged per shard (in-memory only); unlisted shards default to #confirmed. */
  readonly #acked = new Map<string, Cookie | null>();
  /** In-flight delivery promise per shard, and next queued delivery promise awaiting dispatch. */
  readonly #sending = new Map<string, Promise<boolean>>();
  readonly #queued = new Map<string, Promise<boolean>>();
  /** Cached rounds from distinct starting points to head: shards sharing the same starting version reuse the same round. */
  #rounds: { head: Cookie; from: Map<string, Round> } | undefined;

  /**
   * Constructs a fanout coordinator; `confirmed` is the previously persisted state (or null). A version persisted for another shard set
   * is dropped: a shard added since never acknowledged it, so rounds from it would skip what that shard's connections missed.
   */
  constructor(host: Host, confirmed: Confirmed | null) {
    this.#host = host;
    // Compares serialized lists, so storage holding anything else also counts as another shard set.
    const same = confirmed !== null && JSON.stringify(confirmed.shards) === JSON.stringify(host.shards);
    this.#confirmed = same ? confirmed.cookie : null;
  }

  /** Returns whether all shards have confirmed through the current head cookie. */
  allAcked() {
    const head = this.#host.head();
    return this.#host.shards.every((shard) => sameCookie(this.#ackedBy(shard), head));
  }

  /** Dispatches updates to all shards (each queuing independently) and awaits completion of currently scheduled rounds. */
  async deliver() {
    await Promise.all(this.#host.shards.map((shard) => this.#deliverTo(shard)));
  }

  #ackedBy(shard: string) {
    const acked = this.#acked.get(shard);
    return acked === undefined ? this.#confirmed : acked;
  }

  /** Delivers a round to a shard: queues at most one pending round behind an in-flight delivery; returns whether delivery succeeded. */
  #deliverTo(shard: string): Promise<boolean> {
    const queued = this.#queued.get(shard);
    if (queued) return queued;
    const prior = this.#sending.get(shard);
    const send = () => {
      this.#queued.delete(shard);
      return this.#sendTo(shard);
    };
    const round = prior ? prior.then(send, send) : send();
    if (prior) this.#queued.set(shard, round);
    this.#sending.set(shard, round);
    const settled = () => {
      if (this.#sending.get(shard) === round) this.#sending.delete(shard);
    };
    void round.then(settled, settled);
    return round;
  }

  /**
   * Sends changes from the shard's acknowledged version to head; marks head acknowledged on success.
   * Reports confirmed when all shards have reached the current head; new writes during delivery advance head and trigger subsequent rounds.
   */
  async #sendTo(shard: string) {
    const head = this.#host.head();
    const from = this.#ackedBy(shard);
    if (sameCookie(from, head)) return true;
    try {
      await this.#host.send(shard, this.#roundFrom(from, head));
    } catch (error) {
      this.#host.failed(shard, error);
      return false;
    }
    this.#acked.set(shard, head);
    if (this.allAcked()) {
      this.#confirmed = head;
      this.#acked.clear();
      this.#rounds = undefined;
      await this.#host.confirmed({ cookie: head, shards: this.#host.shards });
    }
    return true;
  }

  /** Returns a round from `from` to `head`: memoized across shards sharing the same starting version. */
  #roundFrom(from: Cookie | null, head: Cookie) {
    if (!this.#rounds || !sameCookie(this.#rounds.head, head)) this.#rounds = { head, from: new Map() };
    const key = from ? `${from.version}.${from.nonce}` : '';
    const round = this.#rounds.from.get(key) ?? this.#host.round(from, head);
    this.#rounds.from.set(key, round);
    return round;
  }
}
