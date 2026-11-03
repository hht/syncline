import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { notifyAll, report } from '../common/listeners.ts';
import type { Chunk, Cookie, Hint, Mutation, Poke, Reset } from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import { answerToken, decodeRows, encode, localWrite, validated } from '../expo/client.ts';
import { deserializeError, deserializeStatus } from '../expo/errors.ts';
import type { Execute } from '../expo/remote-database.ts';
import { type Delivered, type Network, type Schedule, Shell, timeout } from '../expo/shell.ts';
import type { SyncStatus } from '../expo/status.ts';
import type { Held } from '../expo/syncline.ts';
import { type Declaration, Handshake, readOnlyOf } from '../tables/declaration.ts';
import { deviceDefinitions, tableName } from '../tables/table-definitions.ts';
import { checkDeclared, type Validation, Validator } from '../tables/validation.ts';
import { Calls, call, type Database, type rustStorage } from './test-rust.ts';

// 测试用的设备：Rust 的设备（编成 wasm）当作 Device 用、它的同步当作 Connection 用，经 Shell 与 Rust 的入口（control）传话；排队、本机写、收缩、
// 核对校验和、连接都在 Rust 里，接入方的 Standard Schema 在 JS 里查。测试可以直接喂拉取结果与消息、读设备的状态（核心的 Probe、Inspect）

/**
 * 打开设备的选项（同 App 的 openSyncline）：validation 是表到 Standard Schema；owner 是私有空间属于谁，discardPending 是换了人时丢掉上一个人没上传的写；
 * localOnly 是本机专用的表，retired 是删掉的表与列，readOnly 是只由云端写的同步表；randomUUID 取客户端编号；checksum 接上在线校验和（rowsPerDay 是每天至多要多少行）
 */
type Options = {
  validation?: Validation;
  owner?: string;
  discardPending?: boolean;
  localOnly?: SQLiteTable[];
  retired?: string[];
  readOnly?: SQLiteTable[];
  randomUUID?: () => string;
  checksum?: { rowsPerDay?: number | undefined };
};

/** 测试的替身 fetch：请求头照设备发的几个头写，替身按名字取 */
type Fetch = (
  url: string,
  init: {
    method?: 'POST';
    headers: { Authorization: string; 'Syncline-Schema'?: string; 'Content-Type'?: 'application/json' };
    body?: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

/** 一个空间的同步的选项：同步地址、取 token；网络、计时与抖动不给就用全局的 */
export type ConnectionOptions = {
  url: string;
  token: () => Promise<string>;
  socket?: (url: string, protocols: string[]) => WebSocket;
  fetch?: Fetch;
  schedule?: Schedule;
  random?: () => number;
};

/** 一个空间的同步在设备那里登记的：它的 token、网络与抖动、收同步状态的 */
export type Attachment = { options: ConnectionOptions; status(status: SyncStatus): void };

export class Device {
  readonly private: Private;
  readonly #calls = new Calls();
  readonly #shell: Shell;
  readonly #db: Database;
  readonly #changes = new Set<(tables: ReadonlySet<string>) => void>();
  readonly #held = new Set<(writes: Held[]) => void>();
  readonly #validator: Validator;
  /** 各空间的同步（键是空间，私有空间是空串）：Shell 只有一个，网络与抖动按最近建的那个空间的同步给的 */
  readonly #attached = new Map<string, Attachment>();
  #network: Network = {};
  #random: () => number = Math.random;

  constructor(
    storage: ReturnType<typeof rustStorage>,
    tables: SQLiteTable[],
    { validation, owner, discardPending = false, localOnly = [], retired = [], readOnly = [], randomUUID, checksum }: Options = {},
  ) {
    const db = storage.database;
    this.#db = db;
    this.#validator = new Validator(tables, validation, localOnly);
    const config = {
      synced: deviceDefinitions(tables),
      localOnly: deviceDefinitions(localOnly),
      readOnly: [...readOnlyOf(tables, readOnly)],
      retired,
      schemas: [...tables, ...localOnly].filter((table) => validation?.has(table)).map(tableName),
    };
    const host = { randomUUID: randomUUID ?? (() => crypto.randomUUID()), random: () => this.#random() };
    const opened = call(() => db.open(JSON.stringify({ config, owner, discardPending, ...(checksum && { checksum }) }), host, Date.now()));
    this.#shell = new Shell(
      db,
      {
        socket: (url, protocols) => (this.#network.socket ?? ((...args) => new WebSocket(...args)))(url, protocols),
        fetch: (url, init) => (this.#network.fetch ?? fetch)(url, init),
        schedule: (run, delay) => (this.#network.schedule ?? timeout)(run, delay),
      },
      (instruction) => this.#deliver(instruction),
    );
    this.#calls.shell = this.#shell;
    this.#shell.begin(opened);
    this.private = new Private(db, this.#calls, '', (channel, attachment) => this.#attach(channel, attachment));
  }

  /** 建一个空间的同步：登记它的 token、网络与抖动，再交给 Rust（它当场报一次状态；同步地址不对就抛） */
  #attach(channel: string, attachment: Attachment) {
    const { socket, fetch, schedule, random } = attachment.options;
    // Shell 的请求头是通用的字符串表，测试的替身 fetch 按 Rust 发的几个头写
    this.#network = {
      ...(socket && { socket }),
      ...(fetch && { fetch: fetch as NonNullable<Network['fetch']> }),
      ...(schedule && { schedule }),
    };
    this.#random = random ?? Math.random;
    this.#attached.set(channel, attachment);
    try {
      this.#calls.now({ type: 'connect', channel, url: attachment.options.url });
    } catch (error) {
      this.#attached.delete(channel);
      throw error;
    }
  }

  #deliver(instruction: Delivered) {
    switch (instruction.type) {
      case 'token':
        return answerToken(this.#attached.get(instruction.channel)?.options.token, instruction.channel, instruction.request, (call) =>
          this.#shell.send(call),
        );
      case 'validate':
        return this.#shell.send({ type: 'validated', write: instruction.write, ...validated(this.#validator, instruction.rows) });
      case 'reply':
        return this.#calls.reply(instruction);
      case 'changed':
        return notifyAll(this.#changes, new Set(instruction.tables));
      case 'held':
        return notifyAll(this.#held, instruction.writes as Held[]);
      case 'report':
        return report(deserializeError(instruction.error));
      case 'warn':
        return console.warn(instruction.message);
      case 'status':
        return this.#attached.get(instruction.channel)?.status(deserializeStatus(instruction.status));
    }
  }

  async query(sql: string, params: unknown[]): Promise<unknown[][]> {
    return decodeRows((await this.#calls.call({ type: 'query', sql, params: params.map(encode) })) as unknown[][]);
  }

  tablesOf(sql: string): string[] {
    return this.#calls.now({ type: 'tablesOf', sql }) as string[];
  }

  /** 本机写：execute 的回复在同一次 control 里就到，同步取 */
  write<T>(body: (execute: Execute) => Promise<T>): Promise<T> {
    const write = this.#calls.id();
    return localWrite(
      write,
      (call, id) => this.#calls.call(call, id),
      () => body((sql, params) => decodeRows(this.#calls.now({ type: 'execute', write, sql, params: params.map(encode) }) as unknown[][])),
    );
  }

  close() {
    this.#shell.send({ type: 'close' });
    this.#shell.close();
  }

  shared(name: string, tables: SQLiteTable[], owner?: string) {
    checkDeclared(tables);
    this.#calls.now({ type: 'shared', name, tables: deviceDefinitions(tables), ...(owner !== undefined && { owner }) });
    return new Shared(this.#db, this.#calls, name, (channel, attachment) => this.#attach(channel, attachment));
  }

  readonly onHeld = (listener: (writes: Held[]) => void) => subscribe(this.#held, listener);
  readonly onChange = (listener: (tables: ReadonlySet<string>) => void) => subscribe(this.#changes, listener);
}

function subscribe<T>(listeners: Set<T>, listener: T) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 建一个空间的同步（Device 登记它、交给 Rust） */
type Attach = (channel: string, attachment: Attachment) => void;

/** 一个空间（私有空间是空串）经 probe 收下拉取结果与连接上的消息、整份重下；共用空间只读，没有待上传、不核对校验和 */
export class Mirror {
  readonly #db: Database;
  readonly calls: Calls;
  readonly channel: string;
  readonly attach: Attach;
  readonly #opened: Promise<void>;

  constructor(db: Database, calls: Calls, channel: string, attach: Attach) {
    this.#db = db;
    this.calls = calls;
    this.channel = channel;
    this.attach = attach;
    // 排在建表后面；没有人等它时不留下没人接的拒绝
    this.#opened = channel === '' ? Promise.resolve() : (calls.probe({ type: 'opened', channel }) as Promise<void>);
    this.#opened.catch(() => undefined);
  }

  opened() {
    return this.#opened;
  }

  /** 读这个空间的状态（核心的 `Inspect`）：不经 Shell，Shell 正做着指令时（测试的替身网络里）也能读 */
  protected inspect(inspect: { type: string } & Record<string, unknown>): unknown {
    return JSON.parse(call(() => this.#db.inspect(JSON.stringify(inspect), Date.now())));
  }

  async receive(poke: Poke | Chunk | Reset): Promise<boolean> {
    return (await this.calls.probe({ type: 'receive', channel: this.channel, pulled: poke })) as boolean;
  }

  async notified(message: Poke | Hint, pulling: boolean): Promise<boolean> {
    return (await this.calls.probe({ type: 'heard', channel: this.channel, message, pulling })) as boolean;
  }

  async resync(discardPending = false): Promise<void> {
    await this.calls.probe({ type: 'resync', channel: this.channel, discardPending });
  }
}

/** 设备的一个共用空间 */
export class Shared extends Mirror {
  cookie(): Cookie | null {
    return this.inspect({ type: 'cookie', channel: this.channel }) as Cookie | null;
  }

  staging() {
    return this.inspect({ type: 'staging', channel: this.channel }) as boolean;
  }

  behind() {
    return this.inspect({ type: 'behind', channel: this.channel }) as boolean;
  }

  pullRequest(): PullRequest {
    return this.inspect({ type: 'pullRequest', channel: this.channel }) as PullRequest;
  }

  connecting() {
    this.calls.now({ type: 'test', probe: { type: 'connecting', channel: this.channel } });
  }
}

/** 设备的私有空间 */
class Private extends Mirror {
  readonly #handshake: Handshake;

  constructor(db: Database, calls: Calls, channel: string, attach: Attach) {
    super(db, calls, channel, attach);
    this.#handshake = new Handshake(this.inspect({ type: 'declaration' }) as Declaration);
  }

  handshake() {
    return this.#handshake;
  }

  cookie(): Cookie | null {
    return this.inspect({ type: 'cookie', channel: '' }) as Cookie | null;
  }

  staging() {
    return this.inspect({ type: 'staging', channel: '' }) as boolean;
  }

  behind() {
    return this.inspect({ type: 'behind', channel: '' }) as boolean;
  }

  pullRequest(): PullRequest {
    return this.inspect({ type: 'pullRequest', channel: '' }) as PullRequest;
  }

  pendingCount() {
    return this.inspect({ type: 'pendingCount' }) as number;
  }

  pending(limit?: number): Mutation[] {
    return this.inspect({ type: 'pending', ...(limit !== undefined && { limit }) }) as Mutation[];
  }

  /** 核对校验和：Rust 里每批之间让出线程；出错由 Rust 照常报出、作罢（回 null），关了库也作罢；别的错照样抛 */
  async verify(): Promise<boolean | undefined> {
    const closed = (error: Error) => {
      if (error.message === '本机库已关闭') return null;
      throw error;
    };
    const matched = (await this.calls.probe({ type: 'verify' }).catch(closed)) as boolean | null;
    return matched ?? undefined;
  }
}
