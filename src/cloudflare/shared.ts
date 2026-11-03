import { DurableObject } from 'cloudflare:workers';
import { Broadcast, defaultShards } from '../cloud/broadcast.ts';
import { Buckets } from '../cloud/buckets.ts';
import { type Events, isolated, quiet } from '../cloud/events.ts';
import { Fanout } from '../cloud/fanout.ts';
import type { Round } from '../cloud/shared.ts';
import { Space } from '../cloud/space.ts';
import { withTimeout } from '../cloud/timeout.ts';
import type { Transaction } from '../cloud/transaction.ts';
import { type Chunk, type Cookie, type Poke, ping, pong, type Reset, socketLimit, subprotocol } from '../common/protocol.ts';
import { type PullRequest, parsePullRequest } from '../common/pull-url.ts';
import { type CloudStorage, queryOf } from '../common/storage.ts';
import { defineTables } from '../tables/table-definitions.ts';
import type { Validation } from '../tables/validation.ts';
import { expiresHeader, numberHeader } from './forward.ts';
import { reserved, ScheduledObject } from './schedule.ts';
import { type SharedDefinition, shardName, subscribedOf } from './shared-forward.ts';
import { Upkeep } from './upkeep.ts';

export { forwardShared, type SharedDefinition, type SharedIdentity, SynclineSharedEntry } from './shared-forward.ts';

/**
 * 共用空间接到 Workers 上（缓存用 Workers Cache）：
 * - 入口（forwardShared）验身份、按令牌定订阅：WebSocket 随机转给一个广播分片；HTTP 拉取去掉 Authorization、把订阅放进 ctx.props，
 *   经 ctx.exports 调开了缓存的入口（SynclineSharedEntry），同一订阅同一网址的响应全网共用一份缓存；
 * - 入口再调共用空间的 Durable Object（DO 本身不能缓存），它按块的种类给缓存时长；
 * - 后台写（mutate）之后把这一轮（改到的行与它们在的桶）并行发给全部广播分片（SynclineBroadcast），分片按每条连接的订阅筛、转给连着的设备；
 *   怎么发（每个分片各自一条，确认了才前进）见 Fanout，这里给它接上分片的 RPC 与超时、落库，没送到的按退避再发。
 * 接入方继承这三个类、传入定义（表与桶规则），在 wrangler 配置里关掉入口 Worker 的缓存、打开 SynclineSharedEntry 子类的缓存。
 * 不该知道的：身份怎么验、订阅怎么从身份定、接入方的业务。
 * @see https://developers.cloudflare.com/workers/cache/examples/
 * @see https://github.com/electric-sql/electric/blob/3f9809fb0bd894cb74470d434749673492ad7acf/packages/sync-service/lib/electric/shapes/api/response.ex
 */

// 全部分片都确认到的那一版，存在共用空间的 KV 里
const fanoutKey = 'syncline:fanout';
// 发一轮在定时表里登记的名字：重发与定时醒是同一件
const deliverName = `${reserved}deliver`;

// 重发的退避
const retryDelay = 1000;
const retry = { base: retryDelay, max: 60_000 };
// 没有要重发时也每隔这么久醒一次（一个共用空间每天 24 次请求）：部署后打开时记了重扫的那一版要发出去；对象要有人叫醒才发得出去，
// 分片不会为游标没变的设备来问，alarm 跨部署留着、醒来跑的是新代码
const refreshInterval = 3_600_000;

/** 给一个分片发一轮至多等多久：一个分片同一时刻只有一轮在路上，卡住的算没送到，不让它排在后面的一轮一直等 */
const notifyTimeout = 10_000;

/**
 * 发给分片的一轮里改到的行至多多少字符：每个分片各收一份（默认 128 片），分片按每条连接的订阅筛，筛出的一条通知仍要在 socketLimit 之内；
 * 取它的 10 倍，订阅很窄的设备也收得到通知，一次大写给每个分片的不过约 24 万字符。超了只发提示，设备去拉
 */
const roundLimit = 10 * socketLimit;

/**
 * 一块可以缓存多久：首个请求（定基准版本）60 秒，让新设备拿到最近的块边界；
 * 末块与重置（最新一版，被广播叫来的设备同时拉）5 秒，一阵请求合并成一次；中间的块由位置决定，过时的副本也照样对（model/Shared.tla），缓存一天
 */
function cacheControl(request: PullRequest, chunk: Poke | Chunk | Reset) {
  // 带下限的请求，响应只能在云端到了下限之后算出（model/Shared.tla）：还没到（伪造的请求）就不进缓存，免得这个网址存着比下限旧的
  if (request.atLeast !== undefined && !('reset' in chunk) && (chunk.seen ?? 0) < request.atLeast) return 'no-store';
  // 带这一代的请求同理：云端不在这一代（分片记着的是上一代，或伪造的）就不进缓存，设备拿到现算的才放下它
  if (request.incarnation !== undefined && chunk.incarnation !== request.incarnation) return 'no-store';
  if ('reset' in chunk || 'cookie' in chunk) return 'public, max-age=5';
  if (request.cursor === undefined) return 'public, max-age=60';
  return 'public, max-age=86400';
}

type SharedOptions<Env> = SharedDefinition & {
  /** 这个共用空间的广播分片 */
  broadcast: (env: Env) => DurableObjectNamespace<SynclineBroadcast>;
  /** 接入方给表的 Standard Schema，后台写按它查 */
  validation?: Validation;
  /** 拉取的块、重置、广播分片没通知到 */
  events?: Events;
  /** 删掉的表与列（「表.列」），不再回到同步，与设备上的一样 */
  retired?: string[];
};

/**
 * 一个共用空间的 Durable Object：只由后台写，设备只读；只经 SynclineSharedEntry 转进来拉取，经 SynclineBroadcast 收通知。
 * 接入方继承它、传入定义（表与桶规则，与入口的同一份）；mutate、schedule、unschedule 与 SynclineSpace 一样是实例上的函数，经 RPC 调不到。
 * alarm 由这里管：发通知与接入方的定时都登记在定时表里，子类不要覆盖 alarm，自己的定时用 schedule 登记、在 scheduled 里做
 */
export class SynclineSharedSpace<Env = unknown> extends ScheduledObject<Env> {
  readonly #space: Space;
  readonly #events: Events;
  readonly #upkeep: Upkeep;
  readonly #fanout: Fanout;

  /** options：定义（表与桶规则，照它建表、补列、建索引）与广播分片等，见 SharedOptions */
  constructor(ctx: DurableObjectState, env: Env, options: SharedOptions<Env>) {
    super(ctx, env);
    const { schema, buckets, chunkRows, validation, events = quiet, retired } = options;
    const tables = Object.values(schema);
    const shared = { buckets, ...(chunkRows && { chunkRows }) };
    const storage = ctx.storage as unknown as CloudStorage;
    const rules = new Buckets(tables, buckets);
    const indexes = defineTables(storage, tables, tables, (table) => rules.indexes(table));
    this.#space = new Space(storage, tables, { shared, events, ...(validation && { validation }), ...(retired && { retired }) });
    this.#events = isolated(events);
    const query = queryOf(storage);
    this.#upkeep = new Upkeep(query, indexes, [], this.timetable, this.#events, {
      counting: this.#space.bucketRows,
      truncation: this.#space,
    });
    const broadcast = options.broadcast(env);
    const name = ctx.id.name ?? '';
    // 发给一个分片至多等 notifyTimeout，卡住的算没送到；全部确认到了落库、登记下一次定时醒
    this.#fanout = new Fanout(
      {
        shards: Array.from({ length: options.shards ?? defaultShards }, (_, index) => shardName(name, index)),
        head: () => this.#space.head(),
        round: (from, head) => this.#space.round(roundLimit, from ?? head),
        send: (shard, round) =>
          withTimeout(broadcast.getByName(shard).notify(round), notifyTimeout, `分片 ${notifyTimeout / 1000} 秒没回话`),
        failed: (shard, error) => this.#events({ type: 'notice.failed', shard, reason: String(error) }),
        confirmed: async (head) => {
          ctx.storage.kv.put(fanoutKey, head);
          this.timetable.at(deliverName, Date.now() + refreshInterval);
          await this.timetable.arm();
        },
      },
      ctx.storage.kv.get<Cookie>(fanoutKey) ?? null,
    );
    // 还有没发完的（打开时记了重扫；全新的库：新建、清空重建之后，分片可能记着上一代的）：马上发一轮，不等定时醒
    // 用 by：分片一直没送到、正在退避时不清掉退避（每次打开对象不各重试一次）
    if (!this.#fanout.allAcked()) this.timetable.by(deliverName, Date.now());
    else if (this.timetable.when(deliverName) === undefined) this.timetable.at(deliverName, Date.now() + refreshInterval);
    // 登记了、alarm 却没排上（登记之后、排之前对象重启了）：照登记的重排
    void ctx.blockConcurrencyWhile(() => this.timetable.arm());
  }

  /** HTTP 拉取的一块：请求在 URL 的查询串里，订阅在入口加的请求头上 */
  override async fetch(request: Request) {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const subscribed = subscribedOf(request);
    if (!subscribed) throw new Error('拉取没经入口转来');
    const pull = parsePullRequest(new URL(request.url));
    const chunk = this.#space.pullShared(pull, subscribed);
    return new Response(JSON.stringify(chunk), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl(pull, chunk) },
    });
  }

  /** 最新一版（广播分片对不上设备的游标时来问）：没有改动的一轮 */
  latest(): Round {
    return this.#space.round(roundLimit);
  }

  /**
   * 后台写：接入方在自己的方法里调用，同步提交，再把这一轮并行发给全部广播分片，等到各分片包含这次提交的那一轮发完；执行出错整条不提交，抛给调用方；抛错不代表没提交（如提交之后、发通知的途中对象被重置），所以重试要能重做。
   * 与提交在同一回合里先登记好重发，再发：发的途中对象被重置（部署、超时），重启后 alarm 照样从落库的那一版发（最新一版比它新），不会只提交不通知
   */
  protected readonly mutate = async (write: (tx: Transaction) => void) => {
    // 设备连的是广播分片，发给分片的一轮另算（round），这里只提交
    const base = this.#space.head();
    this.#space.mutate(write, 0);
    // 没改到同步的行就没有新的一版，不发
    if (this.#space.head().version === base.version) return;
    // 日志超了上限就登记截日志
    this.#upkeep.written();
    this.timetable.by(deliverName, Date.now() + retryDelay);
    await this.timetable.arm();
    await this.#fanout.deliver();
  };

  /** 定时表里到时候了的：后台收拾的事、发通知（mutate 与没送到时登记的重发、定时醒）与接入方的定时；做完把 alarm 排到下一件 */
  override async alarm() {
    await this.timetable.run(
      // 没送到的分片已各报了 notice.failed
      (name) =>
        this.#upkeep.chore(name) ?? (name === deliverName ? { run: () => this.#redeliver(), retry, failed: () => undefined } : undefined),
      (name) => this.scheduled(name),
    );
  }

  /** alarm 里的重发与定时醒：还有没跟上的分片就抛出，按退避重排 */
  async #redeliver() {
    await this.#fanout.deliver();
    // 判跟上与登记在同一段同步代码里：中间插进来的写登记的重发不会被定时醒盖掉
    if (!this.#fanout.allAcked()) throw new Error('还有分片没送到');
    // 都已跟上：定时醒照样续上（这次一轮也没发时 Fanout 不报 confirmed、不登记），不然之后只能等外面的请求叫醒
    this.timetable.at(deliverName, Date.now() + refreshInterval);
    return false;
  }
}

/**
 * 共用空间的一个广播分片：把可休眠的 WebSocket 接到 Broadcast 上（知道到哪一轮只在内存里，推给每条连接的最后一版在连接的附带数据里）。
 * 接入方继承它、传入共用空间的命名空间
 */
export class SynclineBroadcast<Env = unknown> extends DurableObject<Env> {
  readonly #broadcast: Broadcast<WebSocket>;
  /** 排着的 alarm 的时刻，null 是没排（只在内存里：休眠、重启后是 undefined，先问存储） */
  #alarm: number | null | undefined;

  /** events：关连接 */
  constructor(ctx: DurableObjectState, env: Env, shared: DurableObjectNamespace<SynclineSharedSpace>, events?: Events) {
    super(ctx, env);
    const name = ctx.id.name ?? '';
    const space = shared.getByName(name.slice(0, name.lastIndexOf('#')));
    this.#broadcast = new Broadcast(ctx, async () => (await space.latest()) as Round, events);
    // 心跳由运行时直接回，不唤醒对象
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(ping, pong));
  }

  override async fetch(request: Request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: 405 });
    const expiresAt = numberHeader(request, expiresHeader);
    const subscribed = subscribedOf(request);
    if (expiresAt === undefined || !subscribed) throw new Error('连接没经入口转来');
    const { 0: client, 1: server } = new WebSocketPair();
    await this.#broadcast.accept(server, parsePullRequest(new URL(request.url)).cookie, expiresAt, subscribed);
    await this.#wakeBy(expiresAt);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': subprotocol } });
  }

  override webSocketMessage(socket: WebSocket) {
    this.#broadcast.receive(socket);
  }

  notify(round: Round) {
    return this.#broadcast.notify(round);
  }

  /** 关掉身份到期的连接，排到下一个到期的 */
  override async alarm() {
    this.#alarm = null;
    const earliest = this.#broadcast.closeExpired();
    if (earliest !== undefined) await this.#wakeBy(earliest);
  }

  /**
   * 身份在 at 到期的连接最迟在 at 之后的整分钟关掉：没排 alarm 或排得更晚，就改排到这一分钟。按分钟合并，一片至多每分钟醒一次
   * （alarm 按一次请求、改排按写一行计费；对象空闲时不计时长）。到期时刻由接入方给、可以很远（alarm 排不到 2189 年之后）：至多排到一天后，醒来再排
   * @see https://developers.cloudflare.com/durable-objects/platform/pricing/
   */
  async #wakeBy(at: number) {
    const minute = Math.ceil(Math.min(at, Date.now() + 86_400_000) / 60_000) * 60_000;
    if (this.#alarm === undefined) this.#alarm = await this.ctx.storage.getAlarm();
    if (this.#alarm !== null && this.#alarm <= minute) return;
    this.#alarm = minute;
    await this.ctx.storage.setAlarm(minute);
  }
}
