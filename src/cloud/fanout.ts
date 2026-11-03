import { type Cookie, sameCookie } from '../common/protocol.ts';
import type { Round } from './shared.ts';

/** 扇出要的外部：分片、最新一版与一轮怎么算、怎么发、确认了怎么存 */
type Host = {
  shards: readonly string[];
  head: () => Cookie;
  /** 从 from 到最新一版 head 的一轮（from 为 null：一轮也没发过，从 head 发一轮空的，分片据此知道这一代） */
  round: (from: Cookie | null, head: Cookie) => Round;
  /** 发一轮给一个分片：返回了算送到，抛错算没送到 */
  send: (shard: string, round: Round) => Promise<void>;
  /** 一个分片没送到（send 抛的错） */
  failed: (shard: string, error: unknown) => void;
  /**
   * 全部分片都确认到了 head：落库的这一版下次打开时交回构造函数。同步的部分（落库）与判断全部确认在同一段代码里，
   * 中间插进来的写不会被盖掉；返回的 Promise 也等到它了结
   */
  confirmed: (head: Cookie) => void | Promise<void>;
};

/**
 * 共用空间把最新一版发给全部广播分片（照 model/Fanout.tla 的 FanTo(s)，每个分片各自一条）：一个分片从它确认到的那一版发到最新，
 * 送到了才前进，没送到的留给下次再发；同一时刻只有一轮在路上，在发时再叫它就排一轮在后面（已排着的就等那一轮），排着的一轮开始时才取最新一版，
 * 排进来之前提交的都在里面；卡住的分片只拖它自己。全部分片都确认到此刻的最新一版时报 confirmed（调用方落库），之后从它算起。
 * 不该知道的：分片是什么、怎么发、多久算卡住，确认的那一版怎么存、之后什么时候再叫。
 */
export class Fanout {
  readonly #host: Host;
  /** 全部分片都确认到的那一版（落库的；null 是一轮也没发过）：落库的比实际的旧只会多发一轮重叠的，分片照收 */
  #confirmed: Cookie | null;
  /** 各分片确认到的那一版（只在内存里）：不在里面的确认到 #confirmed */
  readonly #acked = new Map<string, Cookie | null>();
  /** 各分片在发的一轮，与排在它后面、还没开始的一轮 */
  readonly #sending = new Map<string, Promise<boolean>>();
  readonly #queued = new Map<string, Promise<boolean>>();
  /** 最新一版从各起点算出的一轮：同一个起点的分片发同一份 */
  #rounds: { head: Cookie; from: Map<string, Round> } | undefined;

  /** confirmed 是上次落库的全部确认到的那一版（没有是 null） */
  constructor(host: Host, confirmed: Cookie | null) {
    this.#host = host;
    this.#confirmed = confirmed;
  }

  /** 全部分片都确认到了此刻的最新一版 */
  allAcked() {
    const head = this.#host.head();
    return this.#host.shards.every((shard) => sameCookie(this.#ackedBy(shard), head));
  }

  /** 发给全部分片（各自排队），等到都发完 */
  async deliver() {
    await Promise.all(this.#host.shards.map((shard) => this.#deliverTo(shard)));
  }

  #ackedBy(shard: string) {
    return this.#acked.has(shard) ? (this.#acked.get(shard) ?? null) : this.#confirmed;
  }

  /** 给一个分片发一轮：在发时排一轮在后面（已排着的就等那一轮）；返回送到了没有 */
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
   * 从这个分片确认到的那一版发到最新；送到了它确认到最新一版。全部分片都确认到此刻的最新一版时报 confirmed；
   * 在等的时候来了新的写就不是，那次写自己会再发一轮
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
      await this.#host.confirmed(head);
    }
    return true;
  }

  /** 从 from 到 head 的一轮：同一个起点的分片发同一份 */
  #roundFrom(from: Cookie | null, head: Cookie) {
    if (!this.#rounds || !sameCookie(this.#rounds.head, head)) this.#rounds = { head, from: new Map() };
    const key = from ? `${from.version}.${from.nonce}` : '';
    const round = this.#rounds.from.get(key) ?? this.#host.round(from, head);
    this.#rounds.from.set(key, round);
    return round;
  }
}
