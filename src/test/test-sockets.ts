import type { Socket } from '../cloud/server.ts';
import { ping, pong } from '../common/protocol.ts';
import { type Message, socketMessage } from './test-trace.ts';

// WebSocket ends in deterministic simulation: client conforms to WHATWG WebSocket states, server conforms to workerd Durable Object behavior.

/** A WebSocket frame: data message (with optional original message for trace verification), or Close frame with code and reason. */
export type Frame = { message: string; original?: string } | { close: number; reason?: string };

/**
 * A simulated WebSocket connection: FIFO queues in each direction.
 * expiresAt tracks token expiry; silent marks unnotified broken links.
 */
export type Link = {
  device: number;
  silent?: true;
  url: string;
  /** Schema fingerprint sent in subprotocols. */
  schema?: string;
  expiresAt: number | undefined;
  client: DeviceEnd;
  server?: CloudEnd;
  toCloud: Frame[];
  toDevice: Frame[];
  /** Whether disconnect was logged to trace (deduplicating dual-sided closes and link cuts). */
  ended?: true;
};

/**
 * Model trace recorder: a is action name, device is device index, optional marks actions skippable in model.
 */
export type Trace = (
  a: string,
  device: number,
  options?: { optional?: boolean; message?: Message; first?: boolean; opened?: boolean },
) => void;

/**
 * Records disconnection event once per connection: deduplicates redundant closes across peers and cuts.
 * opened indicates connection reached active state in shared space model.
 */
export function traceDisconnect(link: Link, trace: Trace | undefined) {
  if (link.ended) return;
  link.ended = true;
  trace?.('Disconnect', link.device, { opened: link.server?.opened() === true });
}

/** Device WebSocket end conforming to WHATWG WebSocket API (0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED). */
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
    if (this.readyState === 0) throw new Error('socket is not open yet');
    if (this.readyState !== 1) return;
    const link = this.#link();
    // Sockets closed immediately upon accept are not considered connected in model.
    if (message !== ping) this.#trace()?.('Push', link.device, { optional: link.server?.readyState !== 1 });
    link.toCloud.push({ message });
  }

  /** Dispatches close event on socket termination. */
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
 * Cloud WebSocket end: mirrors workerd Durable Object socket behavior:
 * remains in getWebSockets while closing until client Close frame arrives.
 */
export class CloudEnd implements Socket {
  readyState = 1;
  #attachment: unknown;
  readonly #link: Link;
  readonly #accepted: Set<CloudEnd>;
  readonly #trace: () => Trace | undefined;
  /** Message index sent to device: first message is catch-up poke (for shared space trace validation). */
  #sent = 0;

  constructor(link: Link, accepted: Set<CloudEnd>, trace: () => Trace | undefined) {
    this.#link = link;
    this.#accepted = accepted;
    this.#trace = trace;
  }

  send(message: string) {
    if (this.readyState !== 1) throw new TypeError("Can't call WebSocket send() after close().");
    // Closed client sockets cannot receive messages; omitted from model trace.
    if (this.#link.client.readyState < 2 && message !== pong) {
      this.#sent += 1;
      this.#trace()?.('Sent', this.#link.device, { message: socketMessage(message), first: this.#sent === 1 });
    }
    this.#link.toDevice.push({ message });
  }

  /** Whether initial message was dispatched (connected in shared space model). */
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

  /** Handles incoming client Close frame; replies automatically if client initiated close. */
  closed(code: number) {
    if (this.readyState === 1) this.#link.toDevice.push({ close: code });
    this.readyState = 3;
    this.#accepted.delete(this);
  }
}

/** Minimal recording socket test double without mock network: logs sent messages, attachments, and close codes. */
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
