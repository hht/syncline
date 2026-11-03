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
/** Cloud end is part of Network interface: Server uses it, tests query active connections. */
export type { CloudEnd } from './test-sockets.ts';

// Deterministic simulation network: test doubles for WebSocket, HTTP, and timers;
// scheduling of delivery, disconnections, responses, and timers is controlled by pseudo-random picker.
// Each connection maintains FIFO queues in both directions; link breaks drop in-flight frames. Includes mock Worker.

export class Network {
  /** Cloud socket ends accepted by active actor: replaced on deploy or PITR restart. */
  accepted = new Set<CloudEnd>();
  /** Mock Worker protocol version: mismatch returns version conflict. */
  cloudVersion = protocolVersion;
  #links: Link[] = [];
  /** HTTP pull requests. */
  readonly #requests: Requests;
  readonly #timers = new Set<{ run: () => void; delay: number }>();
  readonly #pick: <T>(items: T[]) => T | undefined;
  readonly #server: () => Cloud;
  readonly #crash: () => void;
  /** Records model actions during trace validation. */
  trace: Trace | undefined;

  /** crash: resets actor when storage encounters InjectedFault (SQLite error resets actor and fails request). */
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

  /** Invokes actor: resets actor on InjectedFault and returns failed. */
  #call<T>(call: () => T, failed: T): T {
    try {
      return call();
    } catch (error) {
      if (!isInjected(error)) throw error;
      this.#crash();
      return failed;
    }
  }

  /** Sockets interface required by Server. */
  sockets() {
    const { accepted } = this;
    return { acceptWebSocket: (socket: CloudEnd) => accepted.add(socket), getWebSockets: () => [...accepted] };
  }

  /** Mock connection options for Device: token, WebSocket, HTTP fetch, and timer scheduler. */
  options(device: number) {
    return {
      token: () => {
        const token = this.#pick(tokens);
        return token ? Promise.resolve(token) : Promise.reject(new Error('failed to get token'));
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

  /** Actions ready to execute without timer advances: frame delivery, handshakes, response generation, delivery. */
  pending() {
    return this.ready().map((kind) => () => this[kind]());
  }

  /** Ready action names. */
  ready() {
    return [
      ...(this.#links.some(({ toCloud, toDevice }) => toCloud.length + toDevice.length > 0) ? (['deliver'] as const) : []),
      ...(this.#links.some(({ server, client }) => !server && client.readyState < 3) ? (['handshake'] as const) : []),
      ...(this.#requests.unanswered() ? (['respond'] as const) : []),
      ...(this.#requests.answered() ? (['arrive'] as const) : []),
    ];
  }

  /** Handshake: forwards accepted token to cloud, opens device socket on success, fails handshake otherwise. */
  handshake() {
    const link = this.#pick(this.#links.filter(({ server }) => !server));
    if (!link) return;
    const { url, expiresAt } = link;
    const refused = mismatched(url, this.cloudVersion);
    if (link.client.readyState >= 2 || (!refused && expiresAt === undefined)) return this.#break(link);
    // Mismatched protocol versions accepted by entry Worker then immediately closed without forwarding to actor.
    link.server = new CloudEnd(link, refused ? new Set() : this.accepted, () => this.trace);
    const server = link.server;
    // Actor fault on accept: actor resets, closing connection.
    const crashed =
      !refused &&
      this.#call(() => {
        void this.#server().accept(server, new URL(url), expiresAt ?? 0, link.schema);
        return false;
      }, true);
    if (crashed) return;
    // Connections closed immediately on accept (no cookie, reset, expired) do not connect in model.
    if (!refused && server.readyState === 1) this.trace?.('Connect', link.device);
    // Version mismatch: closed immediately with Close frame queued before open.
    if (refused) link.server.close(versionMismatch, String(this.cloudVersion));
    link.client.readyState = 1;
    link.client.onopen?.();
  }

  /** Delivers leading frame across connection queues. */
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

  /** Frame arrived at cloud. Following workerd: messages sent during closing handshake still reach actor. */
  #arriveAtCloud(link: Link, frame: Frame) {
    if ('close' in frame) link.server?.closed(frame.close);
    else if (!link.server || link.server.readyState === 3) return;
    // Durable Object auto-reply: runtime responds with pong directly.
    else if (frame.message === ping) link.toDevice.push({ message: pong });
    else {
      const server = link.server;
      // Messages on closing socket are dropped in model.
      const message = pushMessage(frame.message);
      if (server.readyState === 1) this.trace?.('HandlePush', link.device, { message });
      else this.trace?.('Drop', link.device, { optional: true, message });
      this.#call(() => this.#server().receive(server, frame.message), undefined);
    }
  }

  #arriveAtDevice(link: Link, frame: Frame) {
    // Corrupted frames disconnect client; modeled as message drop.
    // Closed device sockets drop received frames.
    if ('message' in frame) {
      // Received frames must be processed in model (TracePrivate.tla).
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
    // Server close: device replies with Close frame (WHATWG).
    if (link.client.readyState === 1) link.toCloud.push({ close: frame.close });
    link.client.closed(frame.close, frame.reason);
  }

  /** Generates response for completed request, or delivers response to device. */
  respond() {
    this.#requests.respond();
  }

  arrive() {
    this.#requests.arrive();
  }

  /** Fires pending timer (reconnect, heartbeat); advances time by within ms when specified. */
  fire(within?: number) {
    const timers = [...this.#timers];
    const timer = within === undefined ? this.#pick(timers) : timers.find(({ delay }) => delay <= within);
    if (timer) this.#timers.delete(timer);
    timer?.run();
    return timer !== undefined;
  }

  /** Breaks random connection. */
  breakOne() {
    this.#break(this.#pick(this.#links));
  }

  /** Silently breaks open connection: neither side notified, detectable only via heartbeat. */
  silenceOne() {
    const link = this.#pick(this.#links.filter(({ server, client }) => server && client.readyState === 1));
    if (link) link.silent = true;
  }

  /** Active or connecting sockets for given device index. */
  live(device: number) {
    return this.#links.filter((link) => link.device === device && link.client.readyState < 2).length;
  }

  /** Whether device has a silent broken connection awaiting heartbeat detection. */
  silent(device: number) {
    return this.#links.some((link) => link.device === device && link.silent);
  }

  /**
   * Corrupts random in-flight response or message: prepends garbled prefix causing parse failure.
   * Device disconnects on parse error and recovers via catch-up.
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

  /** Fails random in-flight request. */
  failOne() {
    this.#requests.failOne();
  }

  /** Device process exit: terminates all associated connections and in-flight requests. */
  disconnect(device: number) {
    for (const link of this.#links.filter((link) => link.device === device)) this.#break(link);
    this.#requests.failAll(device);
  }

  /** Actor restart (deploy, PITR): closes all active connections. */
  restart() {
    for (const link of [...this.#links]) this.#break(link);
    this.accepted = new Set();
  }

  /** Drops frame on broken or silent link: recorded as Drop in model trace. */
  #lost(link: Link, frame: Frame, toCloud: boolean) {
    if (!('message' in frame) || frame.message === ping || frame.message === pong) return;
    const message = toCloud ? pushMessage(frame.message) : socketMessage(frame.original ?? frame.message);
    this.trace?.('Drop', link.device, { optional: true, message });
  }

  /** Breaks network link: drops in-flight frames, closes server end, notifies client with code 1006. */
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

  /** Prunes closed links with empty queues. */
  #prune() {
    this.#links = this.#links.filter(
      ({ client, server, toCloud, toDevice }) =>
        client.readyState < 3 || (server && server.readyState < 3) || toCloud.length + toDevice.length > 0,
    );
  }
}

/** Connection for device 0: reliable token, zero-jitter backoff (reconnects within 1s drain window). */
export const connectWithoutJitter = (network: Network, device: Device) =>
  new Connection(device.private, { url: 'https://sync.test/space', ...network.options(0), token: async () => 'valid', random: () => 0 });
