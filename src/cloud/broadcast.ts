import { report } from '../common/listeners.ts';
import {
  type Cookie,
  expired,
  expiresIn,
  type Hint,
  newer,
  type Op,
  type Point,
  type Poke,
  pullNeeded,
  sameCookie,
  socketLimit,
} from '../common/protocol.ts';
import { fitsBytes } from '../common/size.ts';
import { type Events, isolated, quiet } from './events.ts';
import { closeSocket, type Socket, type Sockets } from './server.ts';
import type { Round, Subscribed } from './shared.ts';

/**
 * 共用空间的一个广播分片怎么把改动推给连着的设备（照 model/Fanout.tla 的分片与连接）：跑在分片的 Durable Object 里，用可休眠的 WebSocket，
 * 一个共用空间默认 128 片，设备随机连一片（一个对象扛不住几十万条连接的扇出）。分片没有数据，内存里只记知道到哪一轮（共用空间每一轮都发来，
 * 即 Round），按每条连接的订阅筛：改前或改后在订阅的桶里的行才给，现在在就给值、不在了给删除（每条连接自己求交集，不登记订阅）；
 * 每条连接记着推给它的最后一版（附带数据，休眠后还在），通知接在它上面，与它的订阅无关的一轮不推。
 * 收到的一轮接不上（分片重置、被驱逐后不知道、漏了一轮，或不同代：代是随机数分不出先后，旧一代的一轮可能晚到）：问共用空间最新一版、记下，给每条连接推它的提示。
 * 设备连上就进推送名单，再问最新一版补齐（问到的只给这条连接用）：补齐之前推给它的都是提示；问到的正好是设备的游标发空的补齐，否则发提示；
 * 问不到就不补齐，之后推来的都是提示（不发接在设备游标上的空补齐：之后的通知会漏掉中间的改动）。不关连接：设备被一起关掉、同一刻重连，会把分片压垮。
 * 这一轮没带行（改到的太多、规则变了）、筛出的通知装不下、或按连着的设备数算一次要占的内存超过 noticeBudget 时，只发提示。
 * 分片没确认的一轮由共用空间再发；发给设备的可以丢：设备重连时补齐。
 * 每条消息带这条连接的订阅的指纹：与设备落地的不同，设备就去拉。身份只知道到期的时刻，与私有空间一样到期就关：推一轮时关，其间没有写也由 alarm 关
 * （closeExpired），设备取新 token 重连、按新的订阅补齐（接入方没调 reconnect() 时，订阅最终也会是当前的）。设备不往分片推写。
 * 不该知道的：共用空间的数据与桶怎么算、身份与订阅怎么从令牌来。
 * @see https://developers.cloudflare.com/durable-objects/best-practices/websockets/
 * @see https://github.com/powersync-ja/powersync-service/blob/12fa59d700ded33dc33770855bde90ffb60ebc8f/packages/service-core/src/sync/BucketChecksumState.ts#L644
 */

/** 一条连接的附带数据：身份到期的时刻、设备的订阅、推给它的最后一版（还没推过、还没补齐是没有） */
type Attachment = { expiresAt: number; pushed?: Point } & Subscribed;

const pointOf = ({ cookie, incarnation }: Round): Point => ({ cookie, incarnation });

/** 向共用空间问最新一版的最短间隔（毫秒） */
const askInterval = 5000;

/** 广播分片默认几片：一片约千条连接（10 万台在前台的设备时），远在一个 DO 的连接与每秒请求的上限之内 */
export const defaultShards = 128;

/**
 * 发一次通知在分片里至多占多少字符：每条连接的 send 各复制一份，
 * 一片连着几千台设备时，通知的字符数 × 连接数超过它就只发提示，分片的内存不随在线量涨（平台给一个对象 128 MB）
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */
export const noticeBudget = 16_000_000;

/**
 * 一片的设备一齐断开后（部署重启全部对象）每秒至多重连多少台：对象的软上限是每秒 1,000 个请求，留一半给别的请求。
 * 发给设备的消息都带上重连的窗口（spread）：连着的设备数 ÷ 这个速率
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */
export const reconnectRate = 500;

/** 一轮里与这份订阅有关的改动：改前或改后在订阅的桶里的行，现在在就给值，不在了给删除；这一轮没带行是 undefined */
function opsFor({ rows }: Round, subscription: ReadonlySet<string>): Op[] | undefined {
  return rows?.flatMap(({ table, key, row, now, touched }): Op[] => {
    if (!touched.some((bucket) => subscription.has(bucket))) return [];
    return row && now.some((bucket) => subscription.has(bucket)) ? [{ op: 'put', table, key, row }] : [{ op: 'del', table, key }];
  });
}

/** 给这份订阅的通知：base 之后的改动筛到这份订阅 */
const pokeOf = (round: Round, sub: string, patch: Op[]): Poke => ({
  base: round.base,
  cookie: round.cookie,
  lmids: {},
  patch,
  incarnation: round.incarnation,
  sub,
});

/** 提示：只带空间的最新一版（与空间的这一代、订阅的指纹） */
const hintOf = ({ cookie, incarnation }: Round, sub: string): Hint => ({ hint: cookie, incarnation, sub });

/** 这一轮给一份订阅的通知；这一轮没带行是 undefined（只能发提示） */
export function noticeFor(round: Round, { subscription, sub }: Subscribed): Poke | undefined {
  const patch = opsFor(round, new Set(subscription));
  return patch && pokeOf(round, sub, patch);
}

export class Broadcast<S extends Socket> {
  readonly #sockets: Sockets<S>;
  readonly #latest: () => Promise<Round>;
  readonly #events: Events;
  /** 知道到的最后一轮（只在内存里：重置、被驱逐后不知道，下一轮来了当作接不上） */
  #known: Round | undefined;
  /** 正在向共用空间问：同时要问的等同一个 */
  #asking: Promise<Round> | undefined;
  /** 上次问到的与问的时刻：askInterval 之内、不比要的旧就不再问（伪造很大的游标反复连上来，不至于每次都打到共用空间） */
  #asked: { round: Round; at: number } | undefined;

  /** latest：向共用空间问最新一版（base 是最新一版、没有改动的一轮）；events 收关连接 */
  constructor(sockets: Sockets<S>, latest: () => Promise<Round>, events: Events = quiet) {
    this.#sockets = sockets;
    this.#latest = latest;
    this.#events = isolated(events);
  }

  /**
   * 接一条新连接：先进推送名单（问的途中来的一轮照样推给它，还没补齐、推的是提示），再问最新一版补齐，问到的只给这条连接用（model/Fanout.tla 的 Connect 与 Catchup）。
   * cookie 是连接网址带的游标（调用方从网址解析好），subscribed 是入口按令牌算出的订阅。先接受再关：workerd 里没接受的 WebSocket 不能关
   */
  async accept(socket: S, cookie: Cookie | null, expiresAt: number, subscribed: Subscribed) {
    this.#sockets.acceptWebSocket(socket);
    socket.serializeAttachment({ expiresAt, ...subscribed } satisfies Attachment);
    // 设备总带游标（拉完才连）
    if (!cookie) return closeSocket(this.#events, socket, pullNeeded, 'no cookie');
    // 问不到（共用空间出错或过载）照常报出，推分片知道的那一版的提示（之后的通知接在它上面）；什么都不知道就不补齐，之后推来的都是提示
    const latest = await this.#ask(this.#known && pointOf(this.#known)).catch((error: unknown) => void report(error));
    const point = latest ?? this.#known;
    if (!point || socket.readyState !== WebSocket.OPEN) return;
    const attachment = socket.deserializeAttachment() as Attachment;
    // 问的途中已经推过更新的（推的是提示）：不再补齐
    if (!newer(pointOf(point), attachment.pushed)) return;
    // 补齐（model/Fanout.tla 的 Catchup）：还没推过、问到的正好是设备的游标，发空的补齐；其余发提示
    const caught = latest && !attachment.pushed && sameCookie(cookie, latest.cookie);
    const message = caught ? pokeOf({ ...latest, base: cookie }, attachment.sub, []) : hintOf(point, attachment.sub);
    socket.send(JSON.stringify({ ...message, spread: this.#spread(), ...expiresIn(expiresAt) }));
    socket.serializeAttachment({ ...attachment, pushed: pointOf(point) } satisfies Attachment);
  }

  /**
   * 共用空间的一轮（model/Fanout.tla 的 ShardReceive）：接不上（什么都不知道、不同代、起点比知道的新）就问最新一版、记下、给每条连接推它的提示，
   * 问不到就抛出（共用空间按退避再发这一轮）；接得上又更新就推给每条连接、记下；重发的、晚到的不收。
   * 推完才记下：推到一半出错时共用空间再发的这一轮还收（推过的连接不再推），不然没推到的连接之后收到的通知会漏掉这一轮
   */
  async notify(round: Round) {
    const known = this.#known;
    if (!known || known.incarnation !== round.incarnation || round.base.version > known.cookie.version) {
      const { rows: _, ...latest } = await this.#ask(pointOf(round));
      this.#push(latest);
      this.#known = latest;
      return;
    }
    if (round.cookie.version <= known.cookie.version) return;
    this.#push(round);
    this.#known = round;
  }

  /**
   * 推一轮给连着的每条连接：推过它或更新的不推；没推过、推过的不是这一代、这一轮没带行的推提示；否则筛出与它的订阅有关的改动，
   * 接在推给它的上一版上推通知，没有就不推（这条连接推到的不动）。筛出的装不下、或订阅相同又接在同一版上的连接合起来太占内存，推提示
   */
  #push(round: Round) {
    const at = pointOf(round);
    const spread = this.#spread();
    // 订阅相同、推到同一版的连接收同一条消息：筛与序列化各只做一次
    const groups = new Map<string, { socket: S; attachment: Attachment }[]>();
    for (const target of this.#due(at)) {
      const { sub, pushed } = target.attachment;
      const key = `${sub} ${pushed?.incarnation} ${pushed?.cookie.version}`;
      const group = groups.get(key);
      if (group) group.push(target);
      else groups.set(key, [target]);
    }
    for (const group of groups.values()) {
      const text = group[0] && this.#textFor(round, group[0].attachment, group.length, spread);
      if (text === undefined) continue;
      for (const { socket, attachment } of group) {
        socket.send(text);
        socket.serializeAttachment({ ...attachment, pushed: at } satisfies Attachment);
      }
    }
  }

  /**
   * 推给一组连接（订阅相同、推到同一版）的消息：与它们的订阅无关是 undefined（不推）；接得上就是筛出的通知，
   * 装不下、或一条的字符数 × 连接数超过 noticeBudget 推提示。改动在 socketLimit 之内，包上别的字段可能超出：与私有空间一样按整条消息的字节复核
   */
  #textFor(round: Round, attachment: Attachment, connections: number, spread: number) {
    const notice = this.#noticeTo(round, attachment);
    if (notice?.patch.length === 0) return undefined;
    const text = notice && JSON.stringify({ ...notice, spread });
    const fits = text && fitsBytes(text, socketLimit) && text.length * connections <= noticeBudget;
    return fits ? text : JSON.stringify({ ...hintOf(round, attachment.sub), spread });
  }

  /** 还没推过 at 或更新的、开着的连接与它们的附带数据；身份到期的关掉 */
  #due(at: Point) {
    const due: { socket: S; attachment: Attachment }[] = [];
    for (const socket of this.#sockets.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = socket.deserializeAttachment() as Attachment;
      if (Date.now() >= attachment.expiresAt) closeSocket(this.#events, socket, expired, 'expired');
      else if (newer(at, attachment.pushed)) due.push({ socket, attachment });
    }
    return due;
  }

  /** 关掉身份到期的连接（model/Shared.tla 的 Expire），给出开着的连接里最早的到期时刻，没有连接是 undefined：分片按它排下一次 alarm */
  closeExpired() {
    let earliest: number | undefined;
    for (const socket of this.#sockets.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const { expiresAt } = socket.deserializeAttachment() as Attachment;
      if (Date.now() >= expiresAt) closeSocket(this.#events, socket, expired, 'expired');
      else earliest = Math.min(earliest ?? expiresAt, expiresAt);
    }
    return earliest;
  }

  /** 推给这条连接的通知：接在推给它的上一版上、筛到它的订阅；没推过、不是这一代、这一轮没带行的没有（推提示） */
  #noticeTo(round: Round, attachment: Attachment): Poke | undefined {
    const { pushed } = attachment;
    if (!pushed || pushed.incarnation !== round.incarnation) return undefined;
    const notice = noticeFor(round, attachment);
    return notice && { ...notice, base: pushed.cookie };
  }

  /**
   * 向共用空间问最新一版：上次问到的不比 atLeast 旧（同一代、版本不小）、又在 askInterval 之内，就用它不再问；
   * 有在问的先等它（同时要问的等同一个，它出错就一起出错），问到的比 atLeast 旧再问一次：收到的一轮据此确认，问到的比它旧，这一轮就没推到连接上
   */
  async #ask(atLeast?: Point): Promise<Round> {
    const asked = this.#asked;
    if (asked && Date.now() - asked.at < askInterval && !(atLeast && newer(atLeast, pointOf(asked.round)))) return asked.round;
    if (this.#asking) {
      const round = await this.#asking;
      return atLeast && newer(atLeast, pointOf(round)) ? this.#ask(atLeast) : round;
    }
    this.#asking = this.#latest()
      .then((round) => {
        this.#asked = { round, at: Date.now() };
        return round;
      })
      .finally(() => {
        this.#asking = undefined;
      });
    return this.#asking;
  }

  /** 重连的窗口（毫秒）：这片连着的设备照 reconnectRate 摊开重连要多久 */
  #spread() {
    return Math.ceil((this.#sockets.getWebSockets().length / reconnectRate) * 1000);
  }

  /** 设备不往分片推写：收到消息就关掉 */
  receive(socket: S) {
    closeSocket(this.#events, socket, 1003, 'read only');
  }
}
