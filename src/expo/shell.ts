import type { SerializedError, SerializedStatus } from './errors.ts';

/**
 * Drives network I/O, timers, and message dispatch around the Rust core.
 *
 * Used in the web Worker and tests (the same responsibilities are handled by native Rust threads on mobile). Dispatches inputs to the core
 * via `control`, translates emitted instructions into WebSocket operations, HTTP requests, and timers, and forwards notifications (replies,
 * changed tables, held writes, sync status, reported errors, token requests, and write validations) upward. Incoming token and validation
 * responses are passed back in via `send`.
 * The core performs no network I/O or timing; this layer does not know sync rules. WebSockets, HTTP requests, and timers use numeric IDs
 * assigned by the core.
 * Events arriving while executing instructions are queued in `#inbox` and processed after the current batch finishes, preserving
 * instruction ordering.
 * HTTP requests time out after inactivity (transport-level timeout handled here; see {@link stallWatch}).
 * What this module must not know: Sync protocol rules or page usage patterns.
 * @see https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.5.4/crates/core/src/sync/interface.rs
 */

/** Event passed to the core (`Input`). */
export type Input = { type: string } & Record<string, unknown>;

type Headers = Record<string, string>;

/** Instruction emitted by the core (`Instruction`). */
type Instruction =
  | Delivered
  | { type: 'connect'; socket: number; url: string; protocols: string[] }
  | { type: 'send'; socket: number; data: string }
  | { type: 'disconnect'; socket: number }
  | { type: 'fetch'; request: number; url: string; method?: 'POST'; headers: Headers; body?: string }
  | { type: 'abort'; request: number }
  | { type: 'schedule'; timer: number; delay: number }
  | { type: 'cancel'; timer: number };

/** Instructions forwarded to the upper layer: token requests reply with `token`, validation requests reply with `validated`. */
export type Delivered =
  | { type: 'reply'; id: number; value?: unknown; error?: SerializedError }
  | { type: 'token'; request: number; channel: string }
  | { type: 'validate'; write: number; rows: { table: string; row: Record<string, unknown> }[] }
  | { type: 'changed'; tables: string[] }
  | { type: 'held'; writes: { reason: string; changes: unknown[] }[] }
  | { type: 'status'; channel: string; status: SerializedStatus }
  | { type: 'report'; error: SerializedError }
  | { type: 'warn'; message: string };

export type Fetch = (url: string, init: { method?: 'POST'; headers: Headers; body?: string; signal: AbortSignal }) => Promise<Response>;

/** Network and timer implementations, defaulting to global APIs (replaced with mocks in tests). */
export type Network = {
  socket?: (url: string, protocols: string[]) => WebSocket;
  fetch?: Fetch;
  schedule?: Schedule;
};

const messageOf = (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown));

/** Timeout duration in milliseconds without received data before an HTTP pull fails. */
export const receiveTimeout = 30_000;

/** Schedules a timer callback and returns a cancellation function. */
export type Schedule = (run: () => void, delay: number) => () => void;

/** Caps setTimeout delay to the signed 32-bit integer maximum to avoid immediate expiration on large values. */
const maxTimeout = 2 ** 31 - 1;

/** Schedules a timer callback using setTimeout. */
export function timeout(run: () => void, delay: number) {
  const timer = setTimeout(run, Math.min(delay, maxTimeout));
  return () => clearTimeout(timer);
}

/**
 * Monitors HTTP receive activity and aborts on stall.
 *
 * `heard()` resets the inactivity timer; on timeout, aborts the request controller and rejects `stalled`.
 * `abort(error)` aborts immediately. `done()` deactivates the watch upon completion.
 */
function stallWatch(schedule: Schedule, controller: AbortController) {
  let cancel: (() => void) | undefined;
  let settled = false;
  let stall: (error: Error) => void = () => undefined;
  const stalled = new Promise<never>((_, reject) => {
    stall = reject;
  });
  const abort = (error: Error) => {
    controller.abort();
    stall(error);
  };
  return {
    stalled,
    abort,
    heard: () => {
      if (settled) return;
      cancel?.();
      cancel = schedule(() => abort(new Error(`Pull timed out (no data received for ${receiveTimeout / 1000}s)`)), receiveTimeout);
    },
    done: () => {
      settled = true;
      cancel?.();
    },
  };
}

/** Reads response body to completion, invoking heard on each received chunk; handles null body for status 204. */
async function readText(response: Response, heard: () => void): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const decoder = new TextDecoder();
  let text = '';
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    heard();
    text += decoder.decode(part.value, { stream: true });
  }
  return text + decoder.decode();
}

export class Shell {
  readonly #core: { control(input: string, now: number): string };
  readonly #socket: NonNullable<Network['socket']>;
  readonly #fetch: Fetch;
  readonly #schedule: Schedule;
  readonly #deliver: (instruction: Delivered) => void;
  readonly #sockets = new Map<number, WebSocket>();
  readonly #requests = new Map<number, AbortController>();
  readonly #timers = new Map<number, () => void>();
  /** Events queued while processing an instruction batch. */
  readonly #inbox: Input[] = [];
  #busy = false;
  #closed = false;

  constructor(core: { control(input: string, now: number): string }, network: Network, deliver: (instruction: Delivered) => void) {
    this.#core = core;
    this.#socket = network.socket ?? ((url, protocols) => new WebSocket(url, protocols));
    // Wraps fetch to preserve global context and avoid "Illegal invocation" in browsers.
    this.#fetch = network.fetch ?? ((url, init) => fetch(url, init));
    this.#schedule = network.schedule ?? timeout;
    this.#deliver = deliver;
  }

  /** Dispatches initial instructions buffered when opening the core device. */
  begin(instructions: string) {
    this.#drain(instructions);
  }

  /** Dispatches an input event to the core and executes resulting instructions, queueing nested events until the batch completes. */
  send(input: Input) {
    if (this.#closed) {
      // Late inputs (token answers, timers, socket events) must not drive a core that a newer shell may now be driving.
      if (typeof input.id === 'number') this.#deliver({ type: 'reply', id: input.id, error: { message: 'local database is closed' } });
      return;
    }
    this.#inbox.push(input);
    this.#drain();
  }

  #drain(first?: string) {
    if (this.#busy) return;
    this.#busy = true;
    try {
      if (first !== undefined) this.#executeAll(first);
      for (let next = this.#inbox.shift(); next; next = this.#inbox.shift()) {
        this.#executeAll(this.#core.control(JSON.stringify(next), Date.now()));
      }
    } finally {
      this.#busy = false;
    }
  }

  #executeAll(instructions: string) {
    for (const instruction of JSON.parse(instructions) as Instruction[]) this.#execute(instruction);
  }

  /**
   * Closes the database shell: cancels timers, closes sockets, and aborts requests. Subsequent calls reply "local database is closed", as the closed core does.
   */
  close() {
    this.#closed = true;
    for (const cancel of this.#timers.values()) cancel();
    for (const socket of this.#sockets.values()) socket.close();
    for (const controller of this.#requests.values()) controller.abort();
    this.#timers.clear();
    this.#sockets.clear();
    this.#requests.clear();
  }

  #execute(instruction: Instruction) {
    switch (instruction.type) {
      case 'connect':
        return this.#connect(instruction.socket, instruction.url, instruction.protocols);
      case 'send':
        return this.#sendOn(instruction.socket, instruction.data);
      case 'disconnect':
        this.#sockets.get(instruction.socket)?.close();
        this.#sockets.delete(instruction.socket);
        return;
      case 'fetch':
        return void this.#request(instruction);
      case 'abort':
        this.#requests.get(instruction.request)?.abort();
        this.#requests.delete(instruction.request);
        return;
      case 'schedule':
        return this.#timers.set(
          instruction.timer,
          this.#schedule(() => {
            this.#timers.delete(instruction.timer);
            this.send({ type: 'fired', timer: instruction.timer });
          }, instruction.delay),
        );
      case 'cancel':
        this.#timers.get(instruction.timer)?.();
        this.#timers.delete(instruction.timer);
        return;
      default:
        return this.#deliver(instruction);
    }
  }

  /** Opens a WebSocket connection and wires lifecycle events back to the core. */
  #connect(id: number, url: string, protocols: string[]) {
    let socket: WebSocket;
    try {
      socket = this.#socket(url, protocols);
    } catch (error) {
      return this.send({ type: 'failed', id, error: messageOf(error) });
    }
    this.#sockets.set(id, socket);
    const live = () => this.#sockets.get(id) === socket;
    socket.onopen = () => live() && this.send({ type: 'opened', socket: id });
    socket.onmessage = ({ data }) => live() && this.send({ type: 'message', socket: id, data: String(data) });
    socket.onclose = ({ code, reason }) => {
      if (!live()) return;
      this.#sockets.delete(id);
      this.send({ type: 'closed', socket: id, code, reason });
    };
  }

  /** Sends data over a WebSocket connection, ignoring write errors on broken sockets since heartbeats detect disconnection. */
  #sendOn(id: number, data: string) {
    try {
      this.#sockets.get(id)?.send(data);
    } catch {
      // Connection broken: heartbeat timeout will detect disconnection.
    }
  }

  /** Executes an HTTP request and reads response text, aborting on receive stall and dropping aborted requests. */
  async #request({ request, url, method, headers, body }: Extract<Instruction, { type: 'fetch' }>) {
    const controller = new AbortController();
    this.#requests.set(request, controller);
    const watch = stallWatch(this.#schedule, controller);
    const read = async () => {
      const init = { headers, signal: controller.signal, ...(method && { method }), ...(body !== undefined && { body }) };
      const response = await this.#fetch(url, init);
      watch.heard();
      return { status: response.status, text: await readText(response, watch.heard) };
    };
    watch.heard();
    const result = await Promise.race([read(), watch.stalled]).catch((error: unknown) => new Error(messageOf(error)));
    watch.done();
    if (this.#requests.get(request) !== controller) return;
    this.#requests.delete(request);
    if (result instanceof Error) this.send({ type: 'failed', id: request, error: result.message });
    else this.send({ type: 'response', request, status: result.status, body: result.text });
  }
}
