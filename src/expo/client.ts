import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { notifyAll, report } from '../common/listeners.ts';
import { readOnlyOf } from '../tables/declaration.ts';
import { deviceDefinitions, tableName } from '../tables/table-definitions.ts';
import { checkDeclared, ValidationError, Validator } from '../tables/validation.ts';
import { deserializeError, deserializeStatus } from './errors.ts';
import type { Delivered } from './shell.ts';
import { offline, type SyncStatus } from './status.ts';
import type { Channel, Held, LocalDatabase, OpenOptions, Schema } from './syncline.ts';

/**
 * App 这一头的 Syncline，三端一样：调用交给下面（手机上的原生模块、web 的 Worker，里面都是 Rust 的设备），回复按编号交回；
 * 改到的表、扣下的写、各空间的同步状态交给订阅者；替下面取 token、按接入方的 Standard Schema 查本机写改到的行（Drizzle 的表与校验只在 JS 里有）。
 * 打开时把 Drizzle 的表编成纯数据交下去，只看声明的检查在这里做。参数与结果按 JSON 传：BLOB 是字节的数组，JSON 写不了的无穷大另标。
 * 不该知道的：下面是什么、库在哪、同步怎么进行。
 */

/** 交给下面的调用（核心的输入，加上开库、关库） */
export type Call = { type: string } & Record<string, unknown>;

/** 下面交回的：核心的指令，与下面坏了（核心线程出错、Worker 坏了） */
export type Received = Delivered | { type: 'broken'; message: string };

type Reply = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** 参数编成 JSON：BLOB 是字节的数组，JSON 写不了的无穷大另标（NaN 照 SQLite 存成空） */
export const encode = (value: unknown) =>
  value instanceof Uint8Array
    ? Array.from(value)
    : typeof value === 'number' && (value === Infinity || value === -Infinity)
      ? { real: String(value) }
      : value;

/** 结果里的 BLOB（字节的数组）还原成 Uint8Array */
export const decodeRows = (rows: unknown[][]) =>
  rows.map((row) => row.map((value) => (Array.isArray(value) ? Uint8Array.from(value) : value)));

/** 打开要交下去的（核心的 `Opening`）：表编成纯数据；在线校验和一直开着，每天的行数不给用核心的默认 */
function opening<S extends Schema>(options: OpenOptions<S>) {
  const { schema, localOnly = {}, retired = [], readOnly = [], validation, owner, discardPending, checksumRowsPerDay } = options;
  const tables = Object.values(schema);
  const localTables = Object.values(localOnly);
  checkDeclared(tables);
  return {
    config: {
      synced: deviceDefinitions(tables),
      localOnly: deviceDefinitions(localTables),
      readOnly: [...readOnlyOf(tables, readOnly)],
      retired,
      schemas: [...tables, ...localTables].filter((table) => validation?.has(table)).map(tableName),
    },
    ...(owner !== undefined && { owner }),
    ...(discardPending && { discardPending }),
    checksum: checksumRowsPerDay === undefined ? {} : { rowsPerDay: checksumRowsPerDay },
  };
}

/** 一个空间的同步在这一头记着的：状态（下面报来之前是占位的「在连」，还不知道同步过没有）、订阅者、token() */
type Space = { status: SyncStatus; listeners: Set<(status: SyncStatus) => void>; token: () => Promise<string> };

const connecting = (): SyncStatus => ({
  ...offline,
  connecting: true,
  pending: 0,
  hasSynced: false,
  downloadError: undefined,
  uploadError: undefined,
  updateNeeded: false,
});

/** listener 加进订阅者，返回取消订阅 */
const subscribe =
  <L>(listeners: Set<L>) =>
  (listener: L) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

/** 调用的回复：signal 中止时带着它的原因失败、不再等（下面照常做完） */
export function abortable(reply: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (!signal) return reply.then(() => undefined);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    reply.then(() => resolve(), reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * 一次本机写跨好几次调用：begin（轮到它时回复，编号就是这次写）、body 里的 execute、end（提交或回滚）；body 抛错就回滚、再抛出原来的错
 * （本机库已关时这次写早已回滚，回滚的回复是出错，不理会）
 */
export async function localWrite<T>(write: number, call: (call: Call, id?: number) => Promise<unknown>, body: () => Promise<T>) {
  await call({ type: 'begin' }, write);
  let result: T;
  try {
    result = await body();
  } catch (error) {
    await call({ type: 'end', write, commit: false }).catch(() => undefined);
    throw error;
  }
  await call({ type: 'end', write, commit: true });
  return result;
}

/** 替下面取一个空间的 token，回 token 调用：token() 同步抛的、拒绝的、没有这个空间的都当取不到，带着出的错（多久没给由核心计时） */
export function answerToken(token: (() => Promise<string>) | undefined, channel: string, request: number, send: (call: Call) => void) {
  new Promise<string>((resolve) => resolve(token ? token() : Promise.reject(new Error(`没有这个空间的同步：${channel}`)))).then(
    (value) => send({ type: 'token', request, token: value }),
    (error: unknown) => send({ type: 'token', request, error: error instanceof Error ? error.message : String(error) }),
  );
}

/**
 * 按 Standard Schema 查本机写改到的行，给出 validated 调用的结果：不合时是哪张表哪里不合；查的时候出了别的错（接入方的 schema 抛错、返回 Promise）
 * 带着它的消息，核心回滚这次写、把错交给写的调用方，不让这次写一直等
 */
export function validated(validator: Validator, rows: { table: string; row: Record<string, unknown> }[]) {
  try {
    for (const { table, row } of rows) validator.checkSchema(table, row);
    return {};
  } catch (error) {
    if (error instanceof ValidationError) return { invalid: { table: error.table, issues: error.issues } };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export class Client {
  readonly #send: (call: Call) => void;
  readonly #validator: Validator;
  readonly #replies = new Map<number, Reply>();
  readonly #spaces = new Map<string, Space>();
  readonly #changes = new Set<(tables: ReadonlySet<string>) => void>();
  readonly #held = new Set<(writes: Held[]) => void>();
  #next = 0;
  /** 下面坏了的原因：之后的调用都以它失败 */
  #broken: Error | undefined;
  /** 开库的回复：各空间的同步等它 */
  #opened: Promise<unknown> = Promise.resolve();
  #closing: Promise<void> | undefined;

  readonly #options: OpenOptions<Schema>;

  constructor(send: (call: Call) => void, options: OpenOptions<Schema>) {
    this.#send = send;
    this.#options = options;
    this.#validator = new Validator(Object.values(options.schema), options.validation, Object.values(options.localOnly ?? {}));
  }

  /**
   * 开库（平台另给的字段放进 open 调用，web 上是库名），开私有空间的同步，回它：开库出错（如换了人、上一个人还有没上传的写）
   * 由各空间的同步记成它们的下载出错，之后的读写回「本机库已关闭」
   */
  open(platform: Record<string, unknown> = {}) {
    const { url, token } = this.#options;
    this.#opened = this.call({ type: 'open', ...platform, options: opening(this.#options) });
    return this.channel('', url, token);
  }

  /** 交下去，等它的回复（出错照 JS 的错还原） */
  call<T>(call: Call, id = this.#id()): Promise<T> {
    if (this.#broken) return Promise.reject(this.#broken);
    return new Promise<T>((resolve, reject) => {
      this.#replies.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#send({ ...call, id });
    });
  }

  #id() {
    this.#next += 1;
    return this.#next;
  }

  /** 下面交回的一批（订阅者抛的错由 notifyAll 报出，接入方的 Standard Schema 出的错回给核心，都不耽误同一批后面的） */
  receive(received: Received[]) {
    for (const message of received) this.#receive(message);
  }

  #receive(message: Received) {
    switch (message.type) {
      case 'reply': {
        const reply = this.#replies.get(message.id);
        this.#replies.delete(message.id);
        if (message.error === undefined) return reply?.resolve(message.value);
        return reply?.reject(deserializeError(message.error));
      }
      case 'changed':
        return notifyAll(this.#changes, new Set(message.tables));
      case 'held':
        return notifyAll(this.#held, message.writes as Held[]);
      case 'status':
        return this.#report(message.channel, deserializeStatus(message.status));
      case 'report':
        return report(deserializeError(message.error));
      case 'warn':
        return console.warn(message.message);
      case 'token':
        return answerToken(this.#spaces.get(message.channel)?.token, message.channel, message.request, this.#send);
      case 'validate':
        return this.#send({ type: 'validated', write: message.write, ...validated(this.#validator, message.rows) });
      case 'broken':
        return this.broken(new Error(message.message));
    }
  }

  /** 下面坏了：在等的调用都以这个错失败、各空间的同步状态记成下载出错，之后的调用直接失败 */
  broken(error: Error) {
    this.#broken = error;
    for (const reply of this.#replies.values()) reply.reject(error);
    this.#replies.clear();
    for (const channel of this.#spaces.keys()) this.failed(channel, error);
  }

  /**
   * 关库（call 由平台给，只发一次，再调给同一个 Promise）。回复到了：还在等的（关库之后才发出的，回复与调用一样按先后，之前发的都已回了）
   * 与之后的调用都以「本机库已关闭」失败，下面已不再交回这一次打开的回复，同步状态不变；再做平台的收尾（closed）。
   * 下面坏了（之前或关的途中）也算关完：库已随它关掉（核心线程先关库再交 broken，坏了的 Worker 已被结束），之后照样能删库
   */
  close(call: Call, closed: () => void) {
    this.#closing ??= this.call<void>(call)
      .catch((error: unknown) => {
        if (error !== this.#broken) throw error;
      })
      .finally(() => {
        this.#broken = new Error('本机库已关闭');
        for (const reply of this.#replies.values()) reply.reject(this.#broken);
        this.#replies.clear();
        closed();
      });
    return this.#closing;
  }

  /** 一个空间在下面打开出错：记成它的下载出错，界面照常从状态里看到 */
  failed(channel: string, error: Error) {
    const space = this.#spaces.get(channel);
    if (space) this.#report(channel, { ...space.status, connecting: false, downloadError: error });
  }

  #report(channel: string, status: SyncStatus) {
    const space = this.#spaces.get(channel);
    if (!space) return;
    space.status = status;
    notifyAll(space.listeners, status);
  }

  /** 本机库：读写交下去 */
  readonly local: LocalDatabase = {
    query: async (sql, params) => decodeRows(await this.call<unknown[][]>({ type: 'query', sql, params: params.map(encode) })),
    tablesOf: (sql) => this.call<string[]>({ type: 'tablesOf', sql }),
    write: (body) => {
      const write = this.#id();
      return localWrite(
        write,
        (call, id) => this.call(call, id),
        () =>
          body(async (sql, params) =>
            decodeRows(await this.call<unknown[][]>({ type: 'execute', write, sql, params: params.map(encode) })),
          ),
      );
    },
    onChange: subscribe(this.#changes),
    onHeld: subscribe(this.#held),
  };

  /** 开一个共用空间的同步（平台的 shared） */
  readonly share = (name: string, tables: SQLiteTable[], url: string, token: () => Promise<string>, owner?: string) =>
    this.channel(name, url, token, { tables, owner });

  /**
   * 开一个空间的同步：等开库，共用空间先占下（tables 是它的表），建好（报一次状态）再开始。出错（开库出错、同步地址不对、表重名）记成这个空间的下载出错，
   * 不停在占位的「在连」
   */
  channel(name: string, url: string, token: () => Promise<string>, shared?: { tables: SQLiteTable[]; owner: string | undefined }): Channel {
    const space: Space = { status: connecting(), listeners: new Set(), token };
    this.#spaces.set(name, space);
    if (shared) checkDeclared(shared.tables);
    const share = shared && {
      type: 'shared',
      name,
      tables: deviceDefinitions(shared.tables),
      ...(shared.owner !== undefined && { owner: shared.owner }),
    };
    this.#opened
      .then(() => share && this.call(share))
      .then(() => this.call({ type: 'connect', channel: name, url }))
      .then(() => this.#send({ type: 'start', channel: name }))
      .catch((error: Error) => this.failed(name, error));
    return {
      status: () => space.status,
      onStatus: subscribe(space.listeners),
      sync: (options) => abortable(this.call({ type: 'sync', channel: name }), options?.signal),
      resync: (options) =>
        abortable(this.call({ type: 'resync', channel: name, discardPending: options?.discardPending ?? false }), options?.signal),
      // 不报错：库没打开、关了、下面坏了时什么也不做（这些已在同步状态里）
      reconnect: () => void this.call({ type: 'reconnect', channel: name }).catch(() => undefined),
    };
  }
}
