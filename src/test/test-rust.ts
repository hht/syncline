import { createRequire } from 'node:module';
import { join } from 'node:path';
import { wasmOutput } from '../build-wasm.mjs';
import { Reject } from '../common/storage.ts';
import { decodeRows, encode } from '../expo/client.ts';
import { deserializeError } from '../expo/errors.ts';
import type { Delivered, Input, Shell } from '../expo/shell.ts';
import type { TableDefinition } from '../tables/table-definitions.ts';
import { type Issue, ValidationError } from '../tables/validation.ts';
import { cursor, savepoint } from './test-driver.ts';

// Rust 的设备一侧（编成 wasm，测试前生成）：加载、设备库、经 Shell 调它的入口

/** wasm 导出的设备库：先当作普通的库，open 之后是设备，经 control 交来事件；语句的参数与结果是 JSON 文本（编法见 wasm 模块开头的说明），改动集直接传字节 */
export type Database = {
  exec(sql: string, bindings: string): string;
  batch(sql: string): void;
  define(tables: string): void;
  prepare(): void;
  inTransaction(): boolean;
  open(options: string, host: { randomUUID(): string; random(): number }, now: number): string;
  control(input: string, now: number): string;
  inspect(inspect: string, now: number): string;
  image(): Uint8Array;
  inject(rule: string): void;
};

/** 调 wasm：拒收、不合声明、开库时的错（消息是 JSON）换成 JS 的对应的错 */
export function call<T>(body: () => T): T {
  try {
    return body();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('{"reject":')) throw new Reject((JSON.parse(message) as { reject: string }).reject);
    if (message.startsWith('{"invalid":')) {
      const { table, issues } = (JSON.parse(message) as { invalid: { table: string; issues: Issue[] } }).invalid;
      throw new ValidationError(table, issues);
    }
    // 开库时的错是核心的 Failure（与 control 回的同一个样子）
    if (message.startsWith('{"message":')) throw deserializeError(JSON.parse(message));
    throw error;
  }
}

/** wasm 的导出：设备库（可从整库导出恢复）与核心用的上限 */
type Exports = { Database: { new (): Database; restored(image: Uint8Array): Database }; limits(): string };

/** 用到时才加载：只有 vitest 的 fast 组先编了 wasm */
let loaded: Exports | undefined;
const load = () => {
  loaded ??= createRequire(import.meta.url)(join(wasmOutput, 'syncline_wasm.js')) as Exports;
  return loaded;
};

/** 核心交出的上限与时长（Rust 的 `limits::documented`）：少了哪个，用它的文档核对就对不上 */
type Limits = Record<
  | 'valueBytes'
  | 'valueChars'
  | 'keyBytes'
  | 'writeRows'
  | 'writeKeyBytes'
  | 'maxRowBytes'
  | 'pushLimit'
  | 'receiveTimeout'
  | 'pingAfter'
  | 'pongWithin'
  | 'baseDelay'
  | 'maxDelay'
  | 'batch'
  | 'rowsPerDay'
  | 'interval'
  | 'askAgainAfter',
  number
>;

export const rustLimits = () => JSON.parse(load().limits()) as Limits;

/**
 * Rust 的内存设备库，与 test-storage 的 deviceStorage 一样用：先执行给的语句；prepare 由 Rust 建 Syncline 自己的表，define 照编出的声明建表；
 * 交给测试的 Device 打开成设备（database）；image() 导出整库，当作系统备份
 */
export function rustStorage(...schema: string[]) {
  const storage = asStorage(new (load().Database)());
  for (const statement of schema) storage.sql.exec(statement);
  return storage;
}

/** 从整库导出恢复出的 Rust 设备库 */
export const restoredRustStorage = (image: Uint8Array) => asStorage(load().Database.restored(image));

function asStorage(db: Database) {
  const sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const { columns, rows, written }: { columns: string[]; rows: unknown[][]; written: number } = JSON.parse(
        db.exec(query, JSON.stringify(bindings.map(encode))),
      );
      return { ...cursor(columns, decodeRows(rows)), rowsWritten: written };
    },
    get databaseSize() {
      const [{ size }] = sql.exec('SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()').toArray() as [
        { size: number },
      ];
      return size;
    },
  };
  const inTransaction = () => db.inTransaction();
  return {
    sql,
    transactionSync: <T>(body: () => T) => savepoint((query) => db.batch(query), inTransaction, body),
    inTransaction,
    prepare: () => db.prepare(),
    database: db,
    define: (tables: TableDefinition[]) => db.define(JSON.stringify(tables)),
    image: (): Uint8Array<ArrayBuffer> => new Uint8Array(db.image()),
  };
}

type Reply = Extract<Delivered, { type: 'reply' }>;
type Call = { type: string } & Record<string, unknown>;

/** 经 Shell 调 Rust 的入口：每次调用一个编号，回复按编号交回；回复在同一次 control 里就到的（执行语句、查读哪些表、占下共用空间）可以同步取 */
export class Calls {
  readonly #waiting = new Map<number, (reply: Reply) => void>();
  #next = 0;
  shell!: Shell;

  id() {
    this.#next += 1;
    return this.#next;
  }

  /** 交来一个调用，等它的回复（出错照 JS 的错还原） */
  call(input: Call, id = this.id()): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, ({ value, error }) => (error ? reject(deserializeError(error)) : resolve(value)));
      this.shell.send({ ...input, id } as Input);
    });
  }

  /** 回复同步就到的调用 */
  now(input: Call): unknown {
    let reply: Reply | undefined;
    const id = this.id();
    this.#waiting.set(id, (delivered) => {
      reply = delivered;
    });
    this.shell.send({ ...input, id } as Input);
    if (!reply) throw new Error(`${input.type} 的回复没有同步回来`);
    if (reply.error) throw deserializeError(reply.error);
    return reply.value;
  }

  /** 测试直接喂的（核心的 `Probe`） */
  probe(probe: Call) {
    return this.call({ type: 'test', probe });
  }

  reply(reply: Reply) {
    const waiting = this.#waiting.get(reply.id);
    this.#waiting.delete(reply.id);
    waiting?.(reply);
  }
}
