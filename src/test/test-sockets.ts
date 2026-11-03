import type { Socket } from '../cloud/server.ts';
import { ping, pong } from '../common/protocol.ts';
import { type Message, socketMessage } from './test-trace.ts';

// 确定性模拟里一条 WebSocket 的两头：设备一头照 WHATWG 的状态，云端一头照 workerd 的行为；帧放进连接两个方向的队列，什么时候送达由替身网络定

/** 连接上的一帧：消息（改坏了的另记原来的，轨迹核对要认出它是哪条），或关闭帧（带关闭码与原因） */
export type Frame = { message: string; original?: string } | { close: number; reason?: string };

/**
 * 一条 WebSocket 连接：两个方向各一个先进先出的队列；expiresAt 是替身 Worker 认出的身份到期的时刻，认不出是 undefined；
 * silent 是悄悄断了（如手机换了网络）：两头都没收到关闭，之后的帧都送不到
 */
export type Link = {
  device: number;
  silent?: true;
  url: string;
  /** 设备带的表结构的指纹（子协议里的） */
  schema?: string;
  expiresAt: number | undefined;
  client: DeviceEnd;
  server?: CloudEnd;
  toCloud: Frame[];
  toDevice: Frame[];
  /** 轨迹里记过这条连接断开了：两头各关一次、断网时都会走到，只记第一次 */
  ended?: true;
};

/**
 * 轨迹核对时记下网络上发生的、模型里有对应动作的事：a 是动作名，device 是哪台设备，optional 是模型里也可以没有它
 * （丢掉的消息：模型里那条消息可能早已不在）
 */
export type Trace = (
  a: string,
  device: number,
  options?: { optional?: boolean; message?: Message; first?: boolean; opened?: boolean },
) => void;

/**
 * 记一条连接断开，只记第一次，一定要做：再记的那次（云端回的关闭帧、断网时正在关的）可能落在设备连上新连接之后，模型会把新连接断掉。
 * 设备先关旧连接再开新的，所以第一次记时模型里连着的只能是这条或没有，没有的（崩溃了、丢了消息已断、从没连上）什么也不做（TracePrivate.tla）。
 * 记成可以没有的话，设备之后重连时模型要把「没断」的那一支连同其后各条的组合都走完才退回来，状态数随之成倍涨、查不完。
 * opened 是这条连接在共用空间的模型里连上了（云端发过第一条，Shared.tla 的 Connect 与第一条在同一步），共用空间的轨迹只认它
 */
export function traceDisconnect(link: Link, trace: Trace | undefined) {
  if (link.ended) return;
  link.ended = true;
  trace?.('Disconnect', link.device, { opened: link.server?.opened() === true });
}

/** 设备一头：Connection 用到的 WebSocket 成员，状态照 WHATWG（0 连接中、1 已打开、2 正在关、3 已关）；发出推送、关掉连接记进轨迹 */
export class DeviceEnd {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readyState = 0;
  readonly #link: () => Link;
  readonly #trace: () => Trace | undefined;

  constructor(link: () => Link, trace: () => Trace | undefined) {
    this.#link = link;
    this.#trace = trace;
  }

  send(message: string) {
    if (this.readyState === 0) throw new Error('连接还没打开');
    if (this.readyState !== 1) return;
    const link = this.#link();
    // 云端接受时就关掉了的连接（设备还没收到关闭帧）：模型里没连上，这次推送也就没有
    if (message !== ping) this.#trace()?.('Push', link.device, { optional: link.server?.readyState !== 1 });
    link.toCloud.push({ message });
  }

  /** 连接关了（收到云端的关闭帧，或网络断了）：派发 close */
  closed(code: number, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  close() {
    if (this.readyState >= 2) return;
    traceDisconnect(this.#link(), this.#trace());
    this.readyState = 2;
    this.#link().toCloud.push({ close: 1000 });
  }
}

/**
 * 云端一头：Durable Object 里服务端那一头的 WebSocket，照 workerd 的行为：云端关了以后，设备回 Close 帧之前它还在 getWebSockets 里（正在关），
 * 这时 send 抛错、再 close 什么也不做；设备先关的，运行时自动回 Close 帧，它立即离开 getWebSockets
 */
export class CloudEnd implements Socket {
  readyState = 1;
  #attachment: unknown;
  readonly #link: Link;
  readonly #accepted: Set<CloudEnd>;
  readonly #trace: () => Trace | undefined;
  /** 发给设备的第几条：第一条是连上时的补齐（共用空间的轨迹核对用） */
  #sent = 0;

  constructor(link: Link, accepted: Set<CloudEnd>, trace: () => Trace | undefined) {
    this.#link = link;
    this.#accepted = accepted;
    this.#trace = trace;
  }

  send(message: string) {
    if (this.readyState !== 1) throw new TypeError("Can't call WebSocket send() after close().");
    // 设备那一头已经关了的（退到后台、断了，关闭帧还在路上）收不到，模型里没有这条
    if (this.#link.client.readyState < 2 && message !== pong) {
      this.#sent += 1;
      this.#trace()?.('Sent', this.#link.device, { message: socketMessage(message), first: this.#sent === 1 });
    }
    this.#link.toDevice.push({ message });
  }

  /** 发过第一条（共用空间的模型里连上了） */
  opened() {
    return this.#sent > 0;
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    this.#link.toDevice.push({ close: code, reason });
  }

  serializeAttachment(value: unknown) {
    this.#attachment = value;
  }

  deserializeAttachment() {
    return this.#attachment;
  }

  /** 收到设备的 Close 帧：设备先关的就自动回一个 */
  closed(code: number) {
    if (this.readyState === 1) this.#link.toDevice.push({ close: code });
    this.readyState = 3;
    this.#accepted.delete(this);
  }
}

/** 云端一头的最小替身（不经替身网络）：记下发出的消息、附带数据与关闭码，关了就是正在关；没接受过的身份不过期 */
export class RecordingSocket implements Socket {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];
  readonly closed: number[] = [];
  #attachment: unknown = { expiresAt: Number.POSITIVE_INFINITY, acceptedAt: 0 };

  send(message: string) {
    this.sent.push(message);
  }

  close(code = 1000) {
    this.closed.push(code);
    this.readyState = WebSocket.CLOSING;
  }

  serializeAttachment(value: unknown) {
    this.#attachment = value;
  }

  deserializeAttachment() {
    return this.#attachment;
  }
}
