import { pushBytes } from '../common/limits.ts';
import { type Pushed, parseMutations } from '../common/parse.ts';
import {
  type Change,
  type Cookie,
  chunkLimit,
  expired,
  expiresIn,
  invalidPush,
  overQuota,
  type Poke,
  pullNeeded,
  pushFailed,
  sameCookie,
  socketLimit,
} from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import { fitsBytes } from '../common/size.ts';
import { schemaFingerprint, schemaMismatch } from '../tables/declaration.ts';
import { type Events, isolated, quiet } from './events.ts';
import type { Oversized, Space } from './space.ts';
import type { Transaction } from './transaction.ts';

/**
 * 一个私有空间的连接怎么接、改动怎么推给在线设备：跑在空间的 Durable Object 里，用可休眠的 WebSocket。
 * 连接 URL 带设备的游标，校验通过就在这条连接上先发补齐，之后每次提交的通知按序跟在后面；
 * 没有游标、游标不在当前历史上（时间点恢复回滚过、截日志截过了）都关掉连接，设备走 HTTP 拉取（整份重拉，待上传留着）再连；补齐或通知太大发提示。
 * 身份只知道到期的时刻：接入方的 Worker 验过 token 才转进来，到期后这条连接收发前就以 expired 关掉。
 * 不该知道的：身份怎么验、接入方的业务、WebSocket 与 HTTP 响应怎么造。
 * @see https://developers.cloudflare.com/durable-objects/best-practices/websockets/
 * @see https://github.com/rocicorp/mono/blob/main/packages/zero-client/src/client/zero.ts（createConnectionURL 的 baseCookie）
 */

/** 连接上用到的部分：Durable Object 里是服务端那一头的 WebSocket。附带数据休眠后还在，这里存身份到期的时刻与接受的时刻（Attachment） */
export type Socket = {
  readonly readyState: number;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

/** 一条连接的附带数据：身份到期的时刻、接受的时刻（毫秒） */
type Attachment = { expiresAt: number; acceptedAt: number };

/** Durable Object 的 ctx 里用到的部分：接受可休眠的连接、取出全部连接 */
export type Sockets<S extends Socket> = { acceptWebSocket(socket: S): void; getWebSockets(): S[] };

/** 一批改几行（额度按它算）：改动认不出的那条只记一次扣下，算一行 */
const rowsOf = (mutations: Pushed[]) =>
  mutations.reduce((rows, mutation) => rows + ('malformed' in mutation ? 1 : mutation.changes.length), 0);

/** 一个私有空间同时默认至多几条连接 */
export const defaultConnections = 32;

/** 关一条连接，报出 connection.closed */
export function closeSocket(events: Events, socket: Socket, code: number, reason: string) {
  events({ type: 'connection.closed', code, reason });
  socket.close(code, reason);
}

/**
 * 写入额度（令牌桶）：一个空间每秒补 rate 行、至多攒 burst 行（行是推来的改动条数）。
 * 一批推来的超过手上的就不执行、以 overQuota 关这条连接，设备按退避重连、重推；一批比 burst 还大时攒满就放行、欠着慢慢补，
 * 不会永远推不上去。额度在对象的内存里：对象被驱逐后重新攒满（一直在推的对象不会空闲到被驱逐）
 * @see https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/
 */
export type Quota = { rate: number; burst: number };

export class Server<S extends Socket> {
  readonly #sockets: Sockets<S>;
  readonly #space: Space;
  readonly #limit: number;
  /** WebSocket 上一条消息至多多少字节 */
  readonly #socketLimit: number;
  readonly #events: Events;
  readonly #quota: Quota | undefined;
  readonly #dailyWrites: number | undefined;
  readonly #connections: number;
  /** 云端的表结构（schemaConflict 的正文）与它的指纹 */
  #schema: { fingerprint: string; text: string } | undefined;
  /** 写入额度手上还有几行（欠着是负数）与上次补的时刻 */
  #tokens: number;
  #filledAt = Date.now();

  /**
   * limit 是 HTTP 拉取的一块约多大，WebSocket 上的一条消息另外封顶在 socketLimit 字节（取两者小的），测试里调小来分块；
   * events 收云端关连接、推送失败；quota 是写入额度，dailyWrites 是设备推来的写每天（UTC）至多写几行（计费的行写），不给就不限；
   * connections 是同时至多几条连接（默认 32）
   */
  constructor(
    sockets: Sockets<S>,
    space: Space,
    limit = chunkLimit,
    events: Events = quiet,
    {
      quota,
      dailyWrites,
      connections = defaultConnections,
    }: { quota?: Quota | undefined; dailyWrites?: number | undefined; connections?: number | undefined } = {},
  ) {
    this.#sockets = sockets;
    this.#space = space;
    this.#limit = limit;
    this.#socketLimit = Math.min(limit, socketLimit);
    this.#events = isolated(events);
    this.#quota = quota;
    this.#dailyWrites = dailyWrites;
    this.#connections = connections;
    this.#tokens = quota?.burst ?? 0;
  }

  /**
   * 接一条新连接，cookie 是连接网址带的游标（调用方从网址解析好），expiresAt 是身份到期的时刻（毫秒），fingerprint 是设备带来的表结构的指纹（不带的不判断），对不上就以 schemaMismatch 关掉、
   * 设备去 HTTP 拉取时判断（见 schemaConflict）。
   * 校验、加入广播与补齐在同一次调用里同步完成，推送插不进来，之后的通知正好接上补齐。
   * 已是最新也发一条空的补齐：设备由它知道已经连上、追平了（照 Zero 的 connected 消息）。补齐装不下一条消息（或要分块）就只发提示，
   * 连接照常开着，设备连着走 HTTP 拉（照 Replicache 的 poke：只叫设备去拉）。
   * 先接受再关：workerd 里没接受的 WebSocket 不能关（抛错）；不接受、直接拒绝握手的话，浏览器的 WebSocket 只收到 1006、看不到原因。
   * space 是入口验过的身份（这是哪个空间）：补齐与提示带上，设备据此认出换了账号
   * @see https://websockets.spec.whatwg.org/#feedback-from-the-protocol
   */
  accept(socket: S, cookie: Cookie | null, expiresAt: number, fingerprint?: string, space?: string) {
    this.#sockets.acceptWebSocket(socket);
    socket.serializeAttachment({ expiresAt, acceptedAt: Date.now() } satisfies Attachment);
    // 入口放过了已经过期的身份：不补齐，照收发时一样关掉
    if (this.#closeExpired(socket)) return;
    if (this.schemaConflict(fingerprint)) return closeSocket(this.#events, socket, schemaMismatch, 'schema');
    // 同时至多 connections 条：多出来的多半是没断干净的旧连接或在刷连接，关掉最早接受的（设备按退避重连）；一个用户设备多的，接入方调大。
    // 按接受的时刻排：workerd 的 getWebSockets 从新到旧给，先倒过来，同一毫秒接受的（DO 里时钟只在 I/O 时走）也是旧的在前
    // @see https://github.com/cloudflare/workerd/blob/v1.20261012.1/src/workerd/io/legacy-hibernation-manager.c%2B%2B（allWs.push_front）
    const others = this.#sockets.getWebSockets().filter((other) => other !== socket && other.readyState === WebSocket.OPEN);
    const excess = others.length + 1 - this.#connections;
    if (excess > 0)
      for (const { stale } of others
        .reverse()
        .map((stale) => ({ stale, at: (stale.deserializeAttachment() as Attachment).acceptedAt }))
        .sort((a, b) => a.at - b.at)
        .slice(0, excess))
        closeSocket(this.#events, stale, 1008, 'too many connections');
    if (!cookie) return closeSocket(this.#events, socket, pullNeeded, 'no cookie');
    // 游标不在当前历史上：增量接不上，设备先经 HTTP 整份重拉再连（模型的 Connect 只在游标在当前历史上时连），不在这条连接上收它的推送
    if (!this.#space.onHistory(cookie)) return closeSocket(this.#events, socket, pullNeeded, 'not on history');
    // 补齐确认游标之后有提交的客户端，一并告诉设备这段里哪几条被扣下：网址只带游标，不随设备的客户端数涨
    const catchUp = this.#space.pull({ cookie }, this.#socketLimit, true);
    const origin = space === undefined ? {} : { space };
    const text = 'next' in catchUp ? undefined : this.#fitting(JSON.stringify({ ...catchUp, ...expiresIn(expiresAt), ...origin }));
    socket.send(text ?? JSON.stringify({ hint: this.#space.head(), ...expiresIn(expiresAt), ...origin }));
  }

  /**
   * 收到一批推送：执行，有新提交就广播通知。过期的连接不执行，关掉；设备重连时带新 token，补齐并重发。
   * 执行不了的写由 Space 扣下、照样推进序号；推送处理不了（push 抛错，存储出错、拼不出通知这类）不推进出错的那条：以 1011 关掉这条连接再抛出，
   * 设备按退避重连、补齐后重发。出错之前已有写提交的话，别的在线设备也没收到它们的通知：发提示，各自连着拉取、不算出错
   * （model 的 HandlePush）。整批解析不了、超出一次推送的上限、认不出写的身份的（设备的缺陷）什么也不执行，以 invalidPush 关掉、报 push.failed（只是改动认不出的那条 Space 扣下）：
   * 设备原样重推只会再被拒，它就不再推。云端已经关掉的连接（接受时就以 4000 拒了的、正在关的）上推来的不执行：
   * 设备在连上那一刻就推，它的游标可能不在当前历史上（模型的 HandlePush 只收当前连接上的推送）
   */
  receive(socket: S, message: string) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (this.#closeExpired(socket)) return;
    let poke: ReturnType<Space['push']>;
    let before: number | undefined;
    try {
      // 当天推来的写到了上限：不解析、不执行，设备按退避重连、重推，第二天照常；没到就执行，可以超出一批。醒来后第一次查要读库，出错照推送出错处理
      if (this.#dailyWrites !== undefined && this.#space.pushedToday() >= this.#dailyWrites)
        return closeSocket(this.#events, socket, overQuota, 'daily writes');
      const mutations = this.#parse(socket, message);
      if (!mutations) return;
      if (!this.#withinQuota(rowsOf(mutations))) return closeSocket(this.#events, socket, overQuota, 'over quota');
      before = this.#space.head().version;
      poke = this.#space.push(mutations, this.#socketLimit);
      // 额度按处理了的扣：一批的工作量到了上限时只处理了前缀，剩下的设备接着推，到时再扣
      const lmids = poke?.lmids ?? {};
      this.#tokens -= rowsOf(mutations.filter(({ client, id }) => id <= (lmids[client] ?? 0)));
    } catch (error) {
      this.#pushFailed(socket, before, error);
      throw error;
    }
    if (poke) this.#broadcast(poke);
  }

  /** 解析一条推送；超过 pushBytes 的不解析（解析本身就可能超出 CPU 上限），与解析不了的一样以 invalidPush 关掉、报 push.failed，返回 undefined */
  #parse(socket: S, message: string) {
    try {
      if (!fitsBytes(message, pushBytes)) throw new Error(`推送超过 ${pushBytes} 字节`);
      return parseMutations(message);
    } catch (error) {
      this.#events({ type: 'push.failed', reason: error instanceof Error ? error.message : String(error) });
      closeSocket(this.#events, socket, invalidPush, 'invalid push');
      return undefined;
    }
  }

  /** 服务端的写：执行并提交，通知发给在线设备（没有在线连接就不拼，导入一批不白读改到的行）；出错不提交，抛给调用方 */
  mutate(write: (tx: Transaction) => void) {
    this.#broadcast(this.#space.mutate(write, this.#online() ? this.#socketLimit : 0));
  }

  /** 重新提交一条扣下的写，通知发给所有在线设备；还执行不了就抛给调用方，照样扣着 */
  resubmit(client: string, id: number, changes?: Change[]) {
    this.#broadcast(this.#space.resubmit(client, id, changes, this.#online() ? this.#socketLimit : 0));
  }

  /**
   * 设备带来的表结构指纹 fingerprint 对不上云端的：给出云端的表结构，HTTP 拉取以它为 schemaConflict 的正文、不拉，
   * 由设备判断兼不兼容；对上了、不带的是 undefined。云端的头一回用到时算
   */
  schemaConflict(fingerprint: string | undefined) {
    if (fingerprint === undefined) return undefined;
    this.#schema ??= (() => {
      const schema = { declaration: this.#space.declaration, retired: [...this.#space.retired] };
      return { fingerprint: schemaFingerprint(schema.declaration), text: JSON.stringify(schema) };
    })();
    return fingerprint === this.#schema.fingerprint ? undefined : this.#schema.text;
  }

  /**
   * HTTP 拉取的一块（请求在 POST 的正文里，调用方解析好）：没有游标就整份，游标在当前历史上就给增量，
   * 否则从头整份；分块中途从请求带的 cursor 接着给。space 同 accept：每块都带上
   */
  pull(request: PullRequest, space?: string) {
    return JSON.stringify({ ...this.#space.pull(request, this.#limit), ...(space === undefined ? {} : { space }) });
  }

  /**
   * 通知发给所有打开着、身份没过期的连接（发出的 WebSocket 消息不计费），过期的关掉。
   * 云端关了、设备还没回 Close 帧的连接仍在 getWebSockets 里（正在关），往它发会抛错；它的设备重连时会补齐
   */
  #broadcast(update: Poke | Oversized) {
    // 没有新的一版（服务端的写没改到同步的行）：没什么可发
    if (update.base && sameCookie(update.base, update.cookie)) return;
    // 改动太多（没拼，Oversized；或拼了超过 socketLimit 字节）：只发提示，设备连着走 HTTP 拉
    const text = ('patch' in update && this.#fitting(JSON.stringify(update))) || JSON.stringify({ hint: update.cookie });
    for (const socket of this.#sockets.getWebSockets())
      if (socket.readyState === WebSocket.OPEN && !this.#closeExpired(socket)) socket.send(text);
  }

  /**
   * 推送处理不了：推送方以 1011 关；版本 before 之后已有写提交的话别的在线设备也没收到通知，给它们发提示、连着拉。
   * before 没读出来（开始处理之前就出错）就是什么也没提交
   */
  #pushFailed(socket: S, before: number | undefined, error: unknown) {
    this.#events({ type: 'push.failed', reason: error instanceof Error ? error.message : String(error) });
    closeSocket(this.#events, socket, pushFailed, 'push failed');
    if (before === undefined || this.#space.head().version === before) return;
    const hint = JSON.stringify({ hint: this.#space.head() });
    for (const other of this.#sockets.getWebSockets()) if (other !== socket && other.readyState === WebSocket.OPEN) other.send(hint);
  }

  /** 这批的 rows 行在不在额度之内（见 Quota）：先补上这阵子攒的；处理完按处理了的扣（receive） */
  #withinQuota(rows: number) {
    if (!this.#quota) return true;
    const { rate, burst } = this.#quota;
    const now = Date.now();
    this.#tokens = Math.min(burst, this.#tokens + ((now - this.#filledAt) / 1000) * rate);
    this.#filledAt = now;
    return this.#tokens >= Math.min(rows, burst);
  }

  #online() {
    return this.#sockets.getWebSockets().some((socket) => socket.readyState === WebSocket.OPEN);
  }

  /** 一条消息在 socketLimit 字节之内就原样返回，超了是 undefined */
  #fitting(text: string) {
    return fitsBytes(text, this.#socketLimit) ? text : undefined;
  }

  /** 身份到期了就以 expired 关掉，返回是否关了：接受时与收发前都先查 */
  #closeExpired(socket: S) {
    if (Date.now() < (socket.deserializeAttachment() as Attachment).expiresAt) return false;
    closeSocket(this.#events, socket, expired, 'expired');
    return true;
  }
}
