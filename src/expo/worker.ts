import initWasm, { type Database, Files } from '../../rust/target/web/syncline_wasm.js';
import wasmUrl from '../../rust/target/web/syncline_wasm_bg.wasm';
import type { Received } from './client.ts';
import { serializeError } from './errors.ts';
import { Shell } from './shell.ts';

/**
 * web 上同步跑在哪：Syncline 自带的专用 Worker，里面是编成 wasm 的 Rust 设备与管 WebSocket、fetch、计时的外壳（Shell），
 * 页面只发调用、收回复与通知，同步的任何一步都不占页面线程。库文件放在 OPFS（opfs-sahpool，同一时刻只能一处打开：{@link Files}）。
 * 整个页面一个 Worker，先后打开的几个库（换了用户）在这里按顺序开、关：每次打开一个编号（instance），只接当前开着的那一次的调用，
 * 关掉的旧的再读写就回「本机库已关闭」，不碰新开的库。开库、关库在这一层，其余的交给核心。
 * 不该知道的：页面怎么用、表里的业务。
 */

/** 页面发来的：哪一次打开的一个调用（核心的输入，加上开库、关库） */
export type HostMessage = { instance: number; call: { type: string; id?: number } & Record<string, unknown> };
/** 发给页面的：某一次打开交回的一批，或照常报出的错（Worker 里没接住的） */
export type WorkerMessage = { instance: number; received: Received[] } | { type: 'error'; error: ReturnType<typeof serializeError> };

const post = (message: WorkerMessage) => self.postMessage(message);

/**
 * 照常报出的错不取消会在页面的 Worker 对象上触发 error，页面当成 Worker 坏了；取消、转给页面报出。
 * 没处理的 Promise 拒绝不会传到页面，同样转过去，页面的错误收集才看得到
 * @see https://html.spec.whatwg.org/multipage/webappapis.html#report-an-exception（DedicatedWorkerGlobalScope 没取消的转给 Worker 对象）
 * @see https://html.spec.whatwg.org/multipage/webappapis.html#unhandled-promise-rejections
 */
function forwardErrors() {
  const forward = (error: unknown) => post({ type: 'error', error: serializeError(error) });
  self.addEventListener('error', (event) => {
    event.preventDefault();
    forward(event.error ?? event.message);
  });
  self.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    forward(event.reason);
  });
}

/** 加载 wasm、装上 OPFS：同一个网站的另一个标签页（它的 Worker）拿着库文件时失败 */
async function load() {
  await initWasm({ module_or_path: wasmUrl });
  try {
    return await Files.install();
  } catch (error) {
    if (error instanceof Error && error.message.includes('NoModificationAllowedError'))
      throw new Error('本机库在另一个标签页里开着：web 上同一时刻只能有一个标签页用它，关掉别的标签页再刷新');
    throw error;
  }
}

/** 开着的一个库 */
type Opened = { instance: number; name: string; db: Database; shell: Shell };

/** 核心回错的样子：wasm 开库出错时消息是核心的错（`Failure`）的 JSON */
const failureOf = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('{') ? JSON.parse(message) : serializeError(error);
};

forwardErrors();
const files = load();
let open: Opened | undefined;

/** 关掉开着的库：停下同步、关掉 socket 与计时，放掉库（关掉文件） */
function closeOpen() {
  if (!open) return;
  open.shell.send({ type: 'close' });
  open.shell.close();
  open.db.free();
  open = undefined;
}

/** 开库：上一次打开的没关（页面没调 close 就又开了）先关掉它，它之后的调用都失败，不留着一份关不掉的同步 */
async function openLibrary(instance: number, name: string, options: unknown) {
  closeOpen();
  const db = (await files).open(name);
  const host = { randomUUID: () => crypto.randomUUID(), random: Math.random };
  let instructions: string;
  try {
    instructions = db.open(JSON.stringify(options), host, Date.now());
  } catch (error) {
    db.free();
    throw error;
  }
  const shell = new Shell(db, {}, (instruction) => post({ instance, received: [instruction] }));
  open = { instance, name, db, shell };
  return () => shell.begin(instructions);
}

/** 关库（只关这一次打开的），remove 时再删库文件 */
async function closeLibrary(instance: number, name: string, remove: boolean) {
  if (open?.instance === instance) closeOpen();
  if (!remove) return;
  if (open?.name === name) throw new Error(`本机库 ${name} 还开着（另一次打开的）：先关掉它再删`);
  (await files).remove(name);
}

async function handle(instance: number, call: HostMessage['call']) {
  const reply = (error?: unknown) =>
    post({ instance, received: [{ type: 'reply', id: call.id ?? 0, ...(error !== undefined && { error: failureOf(error) }) }] });
  if (call.type === 'open' || call.type === 'close') {
    try {
      // 开库：先回复，再做打开时攒下的指令（报出的问题、各空间的状态排在回复后面）
      const begin =
        call.type === 'open'
          ? await openLibrary(instance, call.name as string, call.options)
          : await closeLibrary(instance, call.name as string, call.remove === true);
      reply();
      begin?.();
    } catch (error) {
      reply(error);
    }
    return;
  }
  if (open?.instance === instance) return open.shell.send(call);
  if (call.id !== undefined) reply(new Error('本机库已关闭'));
}

/** 开库、关库要等（加载 wasm、OPFS），调用按到达的顺序一条做完再做下一条；没接住的错报给页面，之后的照常做 */
let queue = Promise.resolve();
self.onmessage = ({ data: { instance, call } }: MessageEvent<HostMessage>) => {
  queue = queue.then(() => handle(instance, call)).catch((error: unknown) => post({ type: 'error', error: serializeError(error) }));
};
