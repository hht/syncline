import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { type Events, isolated, quiet } from '../cloud/events.ts';
import type { SpaceChecksum } from '../cloud/pulls.ts';
import { type Quota, Server } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import type { Transaction } from '../cloud/transaction.ts';
import { pullBytes } from '../common/limits.ts';
import { type Change, ping, pong, subprotocol } from '../common/protocol.ts';
import { type PullRequest, parsePullBody, parsePullRequest } from '../common/pull-url.ts';
import { type CloudStorage, queryOf } from '../common/storage.ts';
import { schemaConflict } from '../tables/declaration.ts';
import { defineTables, type Schema, tableName } from '../tables/table-definitions.ts';
import type { Validation } from '../tables/validation.ts';
import { expiresHeader, numberHeader, spaceHeader } from './forward.ts';
import { isSocket, schemaFingerprintOf } from './requests.ts';
import { type Chore, reserved, ScheduledObject } from './schedule.ts';
import { Upkeep } from './upkeep.ts';

/**
 * cloud：云端的表（表名 → Drizzle 表）：同名的同步表在云端的样子（可多出只在云端的列）与只在云端的表，照它建表、补列；不给就照同步的表建；
 * retired：删掉的同步表与列（「表.列」），不再回到同步，与设备上的一样；
 * validation：接入方给表的 Standard Schema，设备推来的行与服务端的写再按它查；
 * readOnly：只由云端写的同步表（与设备上的一样），设备推来的写改到就扣下；
 * events：扣下的写、推送失败、重置、关连接、拉取的块，接入方记日志、指标与告警；
 * writeQuota：设备推送的写入额度（Quota，每秒补几行、至多攒几行），不给就不限；
 * dailyWrites：设备推来的写每天（UTC）至多写几行（计费的行写，含索引与提交记录；服务端的写不算），到了当天就不再执行、第二天照常，不给就不限；
 * connections：同时至多几条连接，默认 32，再连上来就关掉最早的一条（一个用户设备多的调大）
 */
export type SpaceOptions = {
  cloud?: Schema;
  retired?: string[];
  readOnly?: SQLiteTable[];
  validation?: Validation;
  events?: Events;
  writeQuota?: Quota;
  dailyWrites?: number;
  connections?: number;
};

/** 接到对象上的一件后台事要的：读一块（Space 的 poll，不报给接入方的事件）、在定时表里登记一件事最迟什么时候做、Syncline 自己的事的名字前缀、接入方的事件 */
type ChoreContext = {
  poll: Space['poll'];
  by: (name: string, at: number) => void;
  reserved: string;
  events: Events;
};

/**
 * 组装根接上的可插拔功能：checksum 是拉取要的校验和怎么算；chores 是后台事（如导出）：
 * 写了之后（打开时同步范围变了也算）告诉它，它在定时表里登记；alarm 里按登记的名字问它要做的事，给出这次 alarm 开始的时刻
 */
export type Features = {
  checksum?: SpaceChecksum;
  chores?: (context: ChoreContext) => { written(): void; chore(name: string, started: number): Chore | undefined };
};

/** 请求的正文，超过 limit 字节就不再读、给 undefined：按读到的字节数，Content-Length 可以不带 */
async function textWithin(request: Request, limit: number) {
  if (!request.body) return '';
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for await (const chunk of request.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) return undefined;
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

const byName = (schema: Schema) => Object.values(schema).map((table) => [tableName(table), table] as const);

/** 云端要建的表：同步的表，同名的换成 cloud 里的，再加上只在 cloud 里的 */
const cloudTables = (schema: Schema, cloud: Schema = {}) => [...new Map([...byName(schema), ...byName(cloud)]).values()];

/**
 * 一个私有空间的 Durable Object（核心，不带可插拔的功能；接入方继承的是接上功能的 SynclineSpace）：
 * 把 Workers 的请求与可休眠的 WebSocket 接到 Server 上，接入方继承它、传入同步的表。
 * 只经 forward 转进来：请求带着入口 Worker 验过的身份到期的时刻与要连的空间。
 * 接入方用的 mutate、held、resubmit、schedule、unschedule 是实例上的函数（不在原型上）：Workers 的 RPC 只开放原型上的方法，它们经 RPC 调不到，
 * 接入方在自己有权限检查的方法里调用。alarm 由这里管：功能的后台事（如导出）与接入方的定时都登记在定时表里，子类不要覆盖 alarm，
 * 自己的定时用 schedule 登记、在 scheduled 里做。
 * 不该知道的：身份怎么验、接入方的业务与它的表怎么建。
 * @see https://developers.cloudflare.com/durable-objects/best-practices/websockets/
 * @see https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/（instance properties are not exposed over RPC）
 * @see https://github.com/cloudflare/partykit/tree/main/packages/partyserver
 */
export class SpaceObject<Env = unknown> extends ScheduledObject<Env> {
  readonly #server: Server<WebSocket>;
  readonly #space: Space;
  /** 功能的后台事（Features 的 chores）；没接的是 undefined */
  readonly #chores: ReturnType<NonNullable<Features['chores']>> | undefined;
  readonly #events: Events;
  readonly #upkeep: Upkeep;

  /** features 是组装根接上的功能 */
  constructor(ctx: DurableObjectState, env: Env, schema: Schema, options: SpaceOptions = {}, { checksum, chores }: Features = {}) {
    super(ctx, env);
    const { cloud, retired, readOnly, validation, events, writeQuota, dailyWrites, connections } = options;
    this.#events = isolated(events ?? quiet);
    // Workers 的类型把 sql.exec().raw() 写成没有 toArray 的迭代器，运行时它有（迭代器辅助方法，Drizzle 也靠它）
    const storage = ctx.storage as unknown as CloudStorage;
    const indexes = defineTables(storage, cloudTables(schema, cloud), Object.values(schema));
    this.#space = new Space(storage, Object.values(schema), {
      ...(validation && { validation }),
      ...(events && { events }),
      ...(retired && { retired }),
      ...(readOnly && { readOnly }),
      ...(checksum && { checksum }),
    });
    this.#server = new Server(ctx, this.#space, undefined, events, { quota: writeQuota, dailyWrites, connections });
    const query = queryOf(storage);
    const keep = byName(cloud ?? {}).map(([name]) => name);
    this.#upkeep = new Upkeep(query, indexes, keep, this.timetable, this.#events, { truncation: this.#space });
    this.#chores = chores?.({
      poll: (position, limit) => this.#space.poll(position, limit),
      by: (name, at) => this.timetable.by(name, at),
      reserved,
      events: this.#events,
    });
    // 打开时同步范围变了、记了提交：照写了之后一样告诉后台事（如排一次导出），不等下一次写
    if (this.#space.evolvedFrom) this.#chores?.written();
    // 登记了、alarm 却没排上（登记之后、排之前对象重启了）：照登记的重排
    void ctx.blockConcurrencyWhile(() => this.timetable.arm());
    // 心跳由运行时直接回，不唤醒对象、不计时长
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(ping, pong));
  }

  /** WebSocket 升级是连接，POST 是 HTTP 拉取（请求在正文里，超过 pullBytes 回 413，认不出回 400） */
  override async fetch(request: Request) {
    const fingerprint = schemaFingerprintOf(request);
    // 只经 forward 转进来：它放的两个头都在
    const expires = numberHeader(request, expiresHeader);
    const space = request.headers.get(spaceHeader);
    if (expires === undefined || space === null) throw new Error('请求没经 forward 转来');
    if (isSocket(request)) {
      const { 0: client, 1: server } = new WebSocketPair();
      this.#server.accept(server, parsePullRequest(new URL(request.url)).cookie, expires, fingerprint, space);
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': subprotocol } });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const schema = this.#server.schemaConflict(fingerprint);
    if (schema) return new Response(schema, { status: schemaConflict, headers: { 'Content-Type': 'application/json' } });
    const body = await textWithin(request, pullBytes);
    if (body === undefined) return new Response(null, { status: 413 });
    let pull: PullRequest;
    try {
      pull = parsePullBody(body);
    } catch {
      return new Response(null, { status: 400 });
    }
    const pulled = this.#server.pull(pull, space);
    return new Response(pulled, { headers: { 'Content-Type': 'application/json' } });
  }

  /**
   * 协议只有文本消息。不写 webSocketClose：设备的 Close 帧由运行时自动回复，要求接入方的兼容日期打开了 web_socket_auto_reply_to_close
   * @see https://developers.cloudflare.com/workers/configuration/compatibility-flags/
   */
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return socket.close(1003, 'text only');
    this.#afterWrite(() => this.#server.receive(socket, message));
  }

  /**
   * 服务端的写（导入、付费回调等，不经设备）：接入方在自己的方法里调用，同步执行，通知发给所有在线设备；出错整条不提交，抛给调用方。
   * 一次写要有上限（导入按批，一批几千行）：平台的存储操作有时间上限，超时就重置对象、调用方拿到错误，写却可能已经提交，
   * 所以重试要能重做（tx.insert 只补没有的行）。经 RPC 调不到：传的函数成了异步的存根，write 要同步执行
   * @see https://developers.cloudflare.com/durable-objects/observability/troubleshooting/（storage operation exceeded timeout）
   */
  protected readonly mutate = (write: (tx: Transaction) => void) => this.#afterWrite(() => this.#server.mutate(write));

  /** 扣下的写（待修复）：设备推来、执行不了的写，原样的改动、原因、记下它的版本与时刻；一次至多 limit 条，after 是上一页最后一条的版本 */
  protected readonly held = (batch?: { limit?: number; after?: number }) => this.#space.held(batch);

  /** 修好数据或代码之后重新提交一条还扣着的写；changes 不给就用原样的改动。成功就不再扣着、通知在线设备，还执行不了（或已经不扣着）就抛给调用方 */
  protected readonly resubmit = (client: string, id: number, changes?: Change[]) =>
    this.#afterWrite(() => this.#server.resubmit(client, id, ...(changes ? [changes] : [])));

  /**
   * 定时表里到时候了的：后台收拾的事、功能的后台事（如导出，每个导出者一件）与接入方的定时；做完把 alarm 排到下一件
   * @see https://developers.cloudflare.com/durable-objects/api/alarms/
   */
  override async alarm() {
    const started = Date.now();
    // 各件同时做：一个卡住或在退避，不占别的时间
    await this.timetable.run(
      (name) => this.#upkeep.chore(name) ?? this.#chores?.chore(name, started),
      (name) => this.scheduled(name),
    );
  }

  /**
   * 时间点恢复的第 1 步（restoreSpace 调用）：库在下次启动时回到 at 那一刻（30 天内）。对象新建后一阵子还没有可恢复的历史，
   * 这时 getBookmarkForTime 抛错、什么也不改。不该直接调：要接着重启（restart）恢复才生效
   * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/（PITR API）
   */
  async restoreTo(at: number) {
    await this.ctx.storage.onNextSessionRestoreBookmark(await this.ctx.storage.getBookmarkForTime(at));
  }

  /**
   * 时间点恢复的第 2 步：重启对象，恢复生效、连接全断（这次调用照例以出错结束）。连接全断是恢复后序号能复用的前提：
   * 旧连接上在路上的推送进不了新的历史（Server.receive 只执行开着的连接上的）
   * @see https://developers.cloudflare.com/durable-objects/api/state/
   */
  restart() {
    this.ctx.abort('时间点恢复');
  }

  /** 做一次可能写了的事：有了新的一版就告诉后台事（如排导出；没新提交的推送不排、不多写） */
  #afterWrite<T>(write: () => T): T {
    const before = this.#space.head().version;
    try {
      return write();
    } finally {
      if (this.#space.head().version !== before) {
        this.#chores?.written();
        this.#upkeep.written();
        void this.timetable.arm();
      }
    }
  }
}

/**
 * 把一个私有空间恢复到 at 那一刻（30 天内）：第 1 步记下恢复点，第 2 步重启对象让恢复生效（重启时这次调用照例出错）。
 * 之后设备重连：游标不在恢复后的历史上的以 4000 关掉、经 HTTP 整份重拉，待上传留着、序号不变，照常推上去，云端跳号接上；
 * 导出者的位置不在历史上时下一块从头整份给
 */
export async function restoreSpace<T extends SpaceObject>(namespace: DurableObjectNamespace<T>, name: string, at: number) {
  await namespace.getByName(name).restoreTo(at);
  await namespace
    .getByName(name)
    .restart()
    .catch(() => undefined);
}
