import type { SerializedError, SerializedStatus } from './errors.ts';

/**
 * Rust 核心外面的那一层（web 的 Worker 里与测试里用，手机上同样的事在原生的 Rust 里做）：把事件交给核心（control），照它回的指令开关 WebSocket、
 * 发 HTTP 请求、排计时器，其余的（回复、改到的表、扣下的写、同步状态、报出的问题、要 token、要校验本机写）交给上面，上面要回的（token、校验结果）照常 send 进来。
 * 核心不做网络与计时，这里不懂同步：socket、请求、计时器都按核心给的编号，到时、到了、断了就带着编号告诉它。
 * 事件在处理一批指令的途中又来了（建 socket 当场出错这类）就排着，这一批做完再交：核心收到的事件与它发出指令的先后一致。
 * HTTP 请求按多久没收到数据计时（属于传输层，核心不管）：请求前就开始计，每收到一段数据重新计，到了就当失败（理由见 {@link stallWatch}）。
 * 不该知道的：同步的规则、页面怎么用。
 * @see https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.5.4/crates/core/src/sync/interface.rs
 */

/** 交给核心的事件（核心的 `Input`） */
export type Input = { type: string } & Record<string, unknown>;

type Headers = Record<string, string>;

/** 核心回的指令（核心的 `Instruction`） */
type Instruction =
  | Delivered
  | { type: 'connect'; socket: number; url: string; protocols: string[] }
  | { type: 'send'; socket: number; data: string }
  | { type: 'disconnect'; socket: number }
  | { type: 'fetch'; request: number; url: string; method?: 'POST'; headers: Headers; body?: string }
  | { type: 'abort'; request: number }
  | { type: 'schedule'; timer: number; delay: number }
  | { type: 'cancel'; timer: number };

/** 交给上面的指令：要 token 的回 `token`，要校验的回 `validated` */
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

/** 网络与计时：不给就用全局的（测试里换成替身） */
export type Network = {
  socket?: (url: string, protocols: string[]) => WebSocket;
  fetch?: Fetch;
  schedule?: Schedule;
};

const messageOf = (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown));

/** 多久没收到数据就当失败（毫秒） */
export const receiveTimeout = 30_000;

/** 安排一次计时，返回取消 */
export type Schedule = (run: () => void, delay: number) => () => void;

/** setTimeout 的延迟是 32 位有符号整数，超过就当 0、立刻触发（云端给的到期时刻、重连窗口可以很长）：截到上限 */
const maxTimeout = 2 ** 31 - 1;

/** 用 setTimeout 安排一次计时（网络与计时不另给时用它） */
export function timeout(run: () => void, delay: number) {
  const timer = setTimeout(run, Math.min(delay, maxTimeout));
  return () => clearTimeout(timer);
}

/**
 * 按多久没收到数据计时：heard() 重新计时，到时中止请求、stalled 以超时失败；abort(error) 立即中止（fetch 不一定理会中止，由 stalled 抛出）；
 * done() 之后不再计时（超时之后 fetch 还可能回来）
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
      cancel = schedule(() => abort(new Error(`拉取超时（${receiveTimeout / 1000} 秒没收到数据）`)), receiveTimeout);
    },
    done: () => {
      settled = true;
      cancel?.();
    },
  };
}

/** 边收边解码读完正文，每收到一段调 heard；没有正文（204 这类）时 body 是 null */
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
  /** 处理一批指令的途中又来的事件 */
  readonly #inbox: Input[] = [];
  #busy = false;

  constructor(core: { control(input: string, now: number): string }, network: Network, deliver: (instruction: Delivered) => void) {
    this.#core = core;
    this.#socket = network.socket ?? ((url, protocols) => new WebSocket(url, protocols));
    // 包一层：直接存全局的 fetch，经对象的属性调用时 this 不对，浏览器的 fetch 会抛 Illegal invocation
    this.#fetch = network.fetch ?? ((url, init) => fetch(url, init));
    this.#schedule = network.schedule ?? timeout;
    this.#deliver = deliver;
  }

  /** 打开设备时核心攒下的指令（打开时报出的问题这类）：照常做 */
  begin(instructions: string) {
    this.#drain(instructions);
  }

  /** 交来一个事件，照核心回的指令做；途中又来的排着，这一批做完再交 */
  send(input: Input) {
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

  /** 关库之后：撤掉计时、关掉 socket、中止请求，之后它们的事不再交给核心（App 再来的调用照常交，核心回「本机库已关闭」） */
  close() {
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

  /** 开一条 WebSocket：关掉了的（disconnect 之后）上面的事不再交，close() 之后照样会派发 close */
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

  /** 发出一条消息；连接已坏时 send 抛错，不理（心跳会发现） */
  #sendOn(id: number, data: string) {
    try {
      this.#sockets.get(id)?.send(data);
    } catch {
      // 连接已坏：核心的心跳等不到回音就当断了
    }
  }

  /** 发一个请求、边收边解码读完正文：多久没收到数据就中止、当失败；被撤掉的（abort）不再交 */
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
