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

// 共用空间的确定性模拟：一个种子决定后台写、收发次序、计时器与故障。跑的是真的 Space（共用空间）、
// Broadcast 与设备一侧（Rust）的共用空间、连接，只把 token、WebSocket、HTTP 与计时器换成替身，HTTP 拉取另经一个替身缓存：
// 同一网址可能拿到之前算的旧副本（带下限、还没到下限算出的不进缓存，照 cacheControl）。
// 故障：断线、悄悄断、请求失败、应答与消息被改坏，共用空间发给分片的通知没送到（之后照退避重发，扇出用的是产品代码），
// 分片重启（连接全断）、休眠后被逐出内存（知道的没了，连接还在），共用空间部署时桶规则改了（打开时记下条件变了的表从下一版起重扫），
// 共用空间清空重建（分片记下的通知可能比它还新，设备的游标在换掉的历史上；轨迹核对时不加：模型里没有），
// 设备崩溃重启、退到后台、换人登录换了订阅（清掉上一个人看过的行）。
// 断言照 model/Shared.tla：设备看到的 = 它落地的订阅在游标那一版看得见的行（按那一版当时的桶规则），
// 故障停止后都追到最新一版、与云端按订阅看得见的行一致；后台数每个桶的行数的一步与写、部署、清空重建交错，数完与各桶看得见的行数相同。
// 末块是比暂存的块旧的副本要几台设备恰好在同一个块边界上交错拉，这里很少出现，
// 由设备一侧收下过时末块的单测与模型守着
// @see https://apple.github.io/foundationdb/testing.html

const url = 'https://sync.test/catalog';
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** 一份订阅（名字）在模型里的桶（TraceShared.tla）：['team', 'a'] 记成 team.a；没有订阅是空的 */
const bucketNames = (name: string | undefined) => (name === undefined ? [] : bucketsOf(name).map((bucket) => bucket.join('.')));
/** 订阅的指纹是哪一份订阅 */
const nameOf = (sub: string | undefined) => subscriptionNames.find((name) => subscriptionOf(name).sub === sub);

class SharedSimulation {
  readonly #random: () => number;
  readonly #pick: ReturnType<typeof picker>;
  readonly #network: Network;
  /** 云端：共用空间、广播分片与替身缓存 */
  readonly #cloud: SharedCloud;
  /** 每份订阅每一版（游标，清空重建之后同一个版本号是另一版）看得见的行（按那一版当时的规则） */
  readonly #history = new Map<string, Row[]>();
  readonly #storages = [0, 1, 2].map(() => deviceStorage(createProgram));
  /** 每台设备上登录的人（App 传的 owner）：换了人先清掉上一个人看过的行 */
  readonly owners: string[] = [];
  readonly #devices: Device[] = [];
  readonly mirrors: ReturnType<Device['shared']>[] = [];
  readonly #connections: Connection[] = [];
  /** 令牌换了、接入方还没调 reconnect() 的设备 */
  readonly #late = new Set<number>();
  /** 轨迹核对时每台设备一条轨迹；不核对是 undefined */
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
   * 网络上的事在模型（Shared.tla）里是哪个动作：分片发出的第一条是连上时的补齐（Connect），之后的是 Push；连接上的消息送到是 Deliver，
   * 拉取的结果送到是 PullDone（缓存里的是哪一版算的、按的哪份订阅）；发拉取是 PullStart；拉取失败、作废是 PullLost；
   * 模型里连上了的连接断了、设备换一条连接是 Disconnect（还没发第一条就断了的模型里没连上）。连接上丢了的消息随断开一起清掉，不另记。
   * 都记成一定要做：可以不做的话 TLC 要把不做的那一支走到很远才排除
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
   * 设备启动（崩溃重启、换人登录）：新的 Device、共用空间与 Connection，登录的是 owner，令牌给这个人的订阅（同名）；进程没了，它的连接与请求都断。
   * 第一次启动是模型的初始状态，之后同一个人是模型的 Crash；换人登录（清掉上一个人看过的行）模型里没有，轨迹核对时不换
   */
  #start(index: number, owner: string) {
    if (this.owners[index] === undefined) this.tracer?.begin(index, bucketNames(owner));
    else if (this.owners[index] === owner) this.tracer?.add(index, 'Crash');
    this.#connections[index]?.stop();
    this.#devices[index]?.close();
    this.#network.disconnect(index);
    // 同一个人重启：重新取的令牌与重启前的一样（可能已经换过订阅）
    if (this.owners[index] !== owner) this.#cloud.subscriptions[index] = owner;
    const device = new Device(this.storage(index), []);
    const mirror = device.shared('catalog', [program], owner);
    this.#devices[index] = device;
    this.mirrors[index] = mirror;
    this.owners[index] = owner;
    this.#connections[index] = started(mirror, `${url}/${index}`, this.#network, index, this.#random);
  }

  /** 退到后台又回来：连接断开、在路上的拉取作废，轨迹里由网络记下 */
  #background(index: number) {
    this.#connections[index]?.stop();
    this.#connections[index]?.start();
  }

  /**
   * 设备的令牌换了（订阅变了，模型的 SubChange）：之后的拉取与新连接按新令牌算，在路上的拉取按旧的或新的；接入方照约定调 reconnect() 换一条连接
   * （令牌变了的回调里），一半时候晚一步调：这之间拉取落地了新订阅，设备自己换连接
   */
  #resubscribe(index: number) {
    const before = this.#cloud.subscriptions[index];
    this.#cloud.resubscribe(index);
    const after = this.#cloud.subscriptions[index] as string;
    if (after !== before) this.tracer?.add(index, 'SubChange', { sub: bucketNames(after) });
    if (this.#random() < 0.5) this.#connections[index]?.reconnect();
    else this.#late.add(index);
  }

  /** 接入方晚一步调的 reconnect()：一台记下了的设备现在调 */
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
      // 退到后台又回来：同一个 Connection 先 stop 再 start
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
   * 收敛（model/Shared.tla 的 S2）：各台设备不再落后、落地在空间的这一代、落地的是令牌现在给的订阅，看到的与云端这份订阅现在看得见的一致
   * （与它的订阅无关的版本分片可以不推，游标可以停在之前）
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

  /** 第 index 台设备落地时按的订阅（名字）；还没同步过是 undefined */
  #landed(index: number) {
    const [row] = this.storage(index).sql.exec("SELECT sub FROM _syncline_cookie WHERE space = 'catalog'").toArray();
    return subscriptionNames.find((name) => subscriptionOf(name).sub === row?.sub);
  }

  /** 这份订阅现在看得见的行 */
  #visible(name: string) {
    return rowsOf(this.#cloud.storage, this.#cloud.definition(), bucketsOf(name));
  }

  /** 第 index 台设备上的行 */
  rows(index: number) {
    return drizzle(this.storage(index)).select().from(program).orderBy(program.id).all();
  }

  /** 云端最新一版各份订阅看得见的行（按当时的规则）记下 */
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
    // 设备看到的 = 它落地的订阅在游标那一版的样子；还没同步过是空的（model/Shared.tla 的 Consistent）
    for (const [index, mirror] of this.mirrors.entries()) {
      const cookie = mirror.cookie();
      const landed = this.#landed(index);
      const expected = cookie ? this.#history.get(`${landed}:${formatCookie(cookie)}`) : [];
      if (!expected) throw new Error(`设备 ${index} 的游标不是云端发出过的版本：${JSON.stringify(cookie)}（${landed}）`);
      expect(this.rows(index), `设备 ${index}（${landed}）在 ${cookie?.version ?? '没同步过'}`).toEqual(expected);
      if (this.#network.live(index) > 1) throw new Error(`设备 ${index} 同时开着 ${this.#network.live(index)} 条连接`);
    }
  }

  close() {
    for (const connection of this.#connections) connection.stop();
  }

  /**
   * 轨迹核对：上次记到之后云端新记的各版（后台写改到的行与它现在的分桶列，不带键的是部署改了规则）与各台设备看得见的状态。
   * 一步至多一次后台写、一次部署，所以「现在的」就是那一版写下的
   */
  #observe() {
    if (!this.tracer) return;
    const versions = this.#cloud.storage.sql
      .exec('SELECT keys FROM _syncline_commit WHERE version > ? ORDER BY version', this.tracer.head)
      .toArray()
      .map(({ keys }): Version => {
        const entries = JSON.parse(String(keys)) as [string, { id: string }][];
        const [entry, ...rest] = entries;
        if (rest.length > 0) throw new Error(`一版改了 ${entries.length} 行，轨迹只记一行的写`);
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
  '共用空间种子 %i：断线、缓存里的旧副本、通知没送到与重发、分片重启、桶规则改了、令牌换了、设备重启与换人下，设备看到的是它落地的订阅在游标那一版的样子，故障停止后追平；后台数完的每个桶的行数与看得见的相同',
  async (seed) => {
    // 设了 SIMULATION_TRACE（一个目录）就记下每台设备的轨迹，交给 model/TraceShared.tla 核对（pnpm model:trace）
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
