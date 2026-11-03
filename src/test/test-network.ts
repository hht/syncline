import { ping, pong } from '../common/protocol.ts';
import { protocolVersion, versionMismatch } from '../common/version.ts';
import type { Device } from './test-device.ts';
import { admitSocket, answer, type Cloud, mismatched, tokens } from './test-entry.ts';
import { garbled, type Pull, Requests } from './test-requests.ts';
import { CloudEnd, DeviceEnd, type Frame, type Link, type Trace, traceDisconnect } from './test-sockets.ts';
import { isInjected } from './test-storage.ts';
import { Connection } from './test-sync.ts';
import { pushMessage, socketMessage } from './test-trace.ts';

export type { Cloud } from './test-entry.ts';
/** 云端一头是 Network 的接口的一部分：Server 用它、测试按它取连接 */
export type { CloudEnd } from './test-sockets.ts';

// 确定性模拟里的网络：WebSocket、HTTP 与计时器的替身，什么时候送达、断开、回应、触发都由调用方的随机数挑。
// 每条连接两个方向各一个先进先出的队列（WebSocket 走 TCP，按序送达），断开时两头在路上的帧都丢掉；替身里也有入口 Worker

export class Network {
  /** 当前对象接受了的云端一头：部署、时间点恢复后对象重启，换一个新的 */
  accepted = new Set<CloudEnd>();
  /** 替身 Worker 的协议版本：设备带的对不上就回它 */
  cloudVersion = protocolVersion;
  #links: Link[] = [];
  /** HTTP 拉取 */
  readonly #requests: Requests;
  readonly #timers = new Set<{ run: () => void; delay: number }>();
  readonly #pick: <T>(items: T[]) => T | undefined;
  readonly #server: () => Cloud;
  readonly #crash: () => void;
  /** 轨迹核对时记下网络上发生的、模型里有对应动作的事 */
  trace: Trace | undefined;

  /** crash：对象的存储出了注入的故障（InjectedFault）时重置对象（平台的做法：SQLite 严重出错就重置对象，这次请求失败） */
  constructor(pick: <T>(items: T[]) => T | undefined, server: () => Cloud, crash: () => void = () => undefined) {
    this.#pick = pick;
    this.#server = server;
    this.#crash = crash;
    this.#requests = new Requests(
      pick,
      (request) =>
        answer(request, this.cloudVersion, this.#server(), () =>
          this.#call(() => this.#server().pull(new URL(request.url), request.body), undefined),
        ),
      () => this.trace,
    );
  }

  /** 调一次对象：存储出了注入的故障就重置对象、给出 failed */
  #call<T>(call: () => T, failed: T): T {
    try {
      return call();
    } catch (error) {
      if (!isInjected(error)) throw error;
      this.#crash();
      return failed;
    }
  }

  /** Server 要的 sockets：当前对象接受与列出它的云端一头 */
  sockets() {
    const { accepted } = this;
    return { acceptWebSocket: (socket: CloudEnd) => accepted.add(socket), getWebSockets: () => [...accepted] };
  }

  /** Connection 的替身入口：某台设备的 token、WebSocket、HTTP 请求与计时器 */
  options(device: number) {
    return {
      token: () => {
        const token = this.#pick(tokens);
        return token ? Promise.resolve(token) : Promise.reject(new Error('取不到 token'));
      },
      socket: (url: string, protocols: string[]) => {
        const link: Link = {
          device,
          url,
          ...admitSocket(protocols),
          client: new DeviceEnd(
            () => link,
            () => this.trace,
          ),
          toCloud: [],
          toDevice: [],
        };
        this.#links.push(link);
        return link.client as unknown as WebSocket;
      },
      fetch: (url: string, init: Parameters<Requests['fetch']>[2]) => this.#requests.fetch(device, url, init),
      schedule: (run: () => void, delay: number) => {
        const timer = { run, delay };
        this.#timers.add(timer);
        return () => this.#timers.delete(timer);
      },
    };
  }

  /** 不用等计时就能做的事：送达在路上的帧、完成握手、算应答、应答送到 */
  pending() {
    return this.ready().map((kind) => () => this[kind]());
  }

  /** 不用等计时就能做的事的名字 */
  ready() {
    return [
      ...(this.#links.some(({ toCloud, toDevice }) => toCloud.length + toDevice.length > 0) ? (['deliver'] as const) : []),
      ...(this.#links.some(({ server, client }) => !server && client.readyState < 3) ? (['handshake'] as const) : []),
      ...(this.#requests.unanswered() ? (['respond'] as const) : []),
      ...(this.#requests.answered() ? (['arrive'] as const) : []),
    ];
  }

  /** 握手：替身 Worker 认出 token 就转给云端，云端接受（校验游标、补齐或关掉），设备一头随即打开；认不出就握手失败 */
  handshake() {
    const link = this.#pick(this.#links.filter(({ server }) => !server));
    if (!link) return;
    const { url, expiresAt } = link;
    const refused = mismatched(url, this.cloudVersion);
    if (link.client.readyState >= 2 || (!refused && expiresAt === undefined)) return this.#break(link);
    // 版本对不上的由入口 Worker 自己接受、随即关掉，不转给对象
    link.server = new CloudEnd(link, refused ? new Set() : this.accepted, () => this.trace);
    const server = link.server;
    // 对象接受时出了故障：对象重置，这条连接随之断开
    const crashed =
      !refused &&
      this.#call(() => {
        void this.#server().accept(server, new URL(url), expiresAt ?? 0, link.schema);
        return false;
      }, true);
    if (crashed) return;
    // 接受时就关掉的（没有游标、要重置、身份过期）在模型里没连上
    if (!refused && server.readyState === 1) this.trace?.('Connect', link.device);
    // 版本对不上的：入口接受后随即关掉，关闭帧排在设备连上之前（设备连上那一刻推的，云端不收）
    if (refused) link.server.close(versionMismatch, String(this.cloudVersion));
    link.client.readyState = 1;
    link.client.onopen?.();
  }

  /** 送达某条连接某个方向上的第一帧 */
  deliver() {
    const queues = this.#links.flatMap((link) => [
      ...(link.toCloud.length > 0 ? [{ link, toCloud: true }] : []),
      ...(link.toDevice.length > 0 ? [{ link, toCloud: false }] : []),
    ]);
    const queue = this.#pick(queues);
    if (!queue) return;
    const { link, toCloud } = queue;
    const frame = (toCloud ? link.toCloud : link.toDevice).shift() as Frame;
    if (link.silent) this.#lost(link, frame, toCloud);
    else if (toCloud) this.#arriveAtCloud(link, frame);
    else this.#arriveAtDevice(link, frame);
    this.#prune();
  }

  /** 帧到了云端。照 workerd：云端关了、设备的 Close 帧还没到之前（正在关），设备发来的消息照样交给对象 */
  #arriveAtCloud(link: Link, frame: Frame) {
    if ('close' in frame) link.server?.closed(frame.close);
    else if (!link.server || link.server.readyState === 3) return;
    // Durable Object 的自动回复：运行时直接回 pong，不交给对象
    else if (frame.message === ping) link.toDevice.push({ message: pong });
    else {
      const server = link.server;
      // 云端正在关的连接上推来的不执行：模型里是丢掉
      const message = pushMessage(frame.message);
      if (server.readyState === 1) this.trace?.('HandlePush', link.device, { message });
      else this.trace?.('Drop', link.device, { optional: true, message });
      this.#call(() => this.#server().receive(server, frame.message), undefined);
    }
  }

  #arriveAtDevice(link: Link, frame: Frame) {
    // 改坏了的：设备解析不了、断开，模型里是丢了这条（连接随之断）
    // 设备那一头已经关了的收不到：是丢了
    if ('message' in frame) {
      // 收下的一定要做，模型里收得下（不断开）就得收（TracePrivate.tla）：记成可以没有的话，模型可以一直留着它，每多一条状态数翻一倍
      if (frame.message !== pong) {
        const received = frame.original === undefined && link.client.readyState === 1;
        this.trace?.(received ? 'Recv' : 'Drop', link.device, {
          optional: !received,
          message: socketMessage(frame.original ?? frame.message),
        });
      }
      if (link.client.readyState === 1) link.client.onmessage?.({ data: frame.message });
      return;
    }
    traceDisconnect(link, this.trace);
    // 云端先关的：设备回一个 Close 帧（WHATWG）
    if (link.client.readyState === 1) link.toCloud.push({ close: frame.close });
    link.client.closed(frame.close, frame.reason);
  }

  /** 云端算好一个请求的应答、一个算好了的应答到了设备 */
  respond() {
    this.#requests.respond();
  }

  arrive() {
    this.#requests.arrive();
  }

  /** 触发一个计时器（重连、心跳）；给了 within 就是时间往前走这么多毫秒，只触发这之内到期的；没有返回 false */
  fire(within?: number) {
    const timers = [...this.#timers];
    const timer = within === undefined ? this.#pick(timers) : timers.find(({ delay }) => delay <= within);
    if (timer) this.#timers.delete(timer);
    timer?.run();
    return timer !== undefined;
  }

  /** 随便一条连接断了 */
  breakOne() {
    this.#break(this.#pick(this.#links));
  }

  /** 随便一条打开了的连接悄悄断了：两头都不知道，只有设备的心跳能发现 */
  silenceOne() {
    const link = this.#pick(this.#links.filter(({ server, client }) => server && client.readyState === 1));
    if (link) link.silent = true;
  }

  /** 这台设备在连着或正在连的连接有几条（设备那一头没关、也不在关） */
  live(device: number) {
    return this.#links.filter((link) => link.device === device && link.client.readyState < 2).length;
  }

  /** 这台设备有没有悄悄断了的连接：两头都不知道，要等心跳发现 */
  silent(device: number) {
    return this.#links.some((link) => link.device === device && link.silent);
  }

  /**
   * 随便一条在路上的应答或发给设备的消息坏了（中间设备、代理改坏了正文）：换成 garbled 开头、解析不了的文本。
   * 设备解析不了就断开、照常报出，重来时补齐，不收半份
   */
  garbleOne() {
    const responses = this.#requests.responses();
    const frames = this.#links.flatMap(({ toDevice }) => toDevice.filter((frame) => 'message' in frame && frame.message !== pong));
    const target = this.#pick<{ request: Pull } | { frame: Frame }>([
      ...responses.map((request) => ({ request })),
      ...frames.map((frame) => ({ frame })),
    ]);
    if (!target) return;
    if ('request' in target) this.#requests.garble(target.request);
    else if ('message' in target.frame) {
      target.frame.original = target.frame.message;
      target.frame.message = garbled;
    }
  }

  /** 随便一个请求失败 */
  failOne() {
    this.#requests.failOne();
  }

  /** 设备进程没了：它的连接与请求都断 */
  disconnect(device: number) {
    for (const link of this.#links.filter((link) => link.device === device)) this.#break(link);
    this.#requests.failAll(device);
  }

  /** 对象重启（部署、时间点恢复）：全部连接断开 */
  restart() {
    for (const link of [...this.#links]) this.#break(link);
    this.accepted = new Set();
  }

  /** 连接上丢了一帧（断了、悄悄断了）：推送与发给设备的通知在模型里是丢了消息；心跳与关闭帧模型里没有 */
  #lost(link: Link, frame: Frame, toCloud: boolean) {
    if (!('message' in frame) || frame.message === ping || frame.message === pong) return;
    const message = toCloud ? pushMessage(frame.message) : socketMessage(frame.original ?? frame.message);
    this.trace?.('Drop', link.device, { optional: true, message });
  }

  /** 网络断了：两头在路上的帧都丢掉，云端那一头关掉，设备那一头收到 1006 */
  #break(link: Link | undefined) {
    if (!link) return;
    for (const frame of link.toCloud) this.#lost(link, frame, true);
    for (const frame of link.toDevice) this.#lost(link, frame, false);
    if (link.client.readyState < 3) traceDisconnect(link, this.trace);
    link.toCloud = [];
    link.toDevice = [];
    if (link.server) {
      link.server.readyState = 3;
      this.accepted.delete(link.server);
    }
    link.client.closed(1006);
    this.#prune();
  }

  /** 两头都关了、路上没有帧的连接不再有事可做 */
  #prune() {
    this.#links = this.#links.filter(
      ({ client, server, toCloud, toDevice }) =>
        client.readyState < 3 || (server && server.readyState < 3) || toCloud.length + toDevice.length > 0,
    );
  }
}

/** 设备 0 的连接：token 恒给得出、退避不抖动（重连都在 drain 让时间走的 1 秒之内） */
export const connectWithoutJitter = (network: Network, device: Device) =>
  new Connection(device.private, { url: 'https://sync.test/space', ...network.options(0), token: async () => 'valid', random: () => 0 });
