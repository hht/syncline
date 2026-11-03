import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { valueBytes } from '../common/limits.ts';
import { restoredRustStorage, rustStorage } from './test-rust.ts';
import { sqliteWasmStorage } from './test-sqlite-wasm.ts';

// 测试用的存储：云端（DO 的替身）与设备的 SQLite 库，备份与时间点恢复的整库导出导入，注入的故障，数执行了几条语句、一条语句读进多少

const sqlite3 = await sqlite3InitModule();

/**
 * DO 的 ctx.storage 的替身：同一个 SQLite，接入方的表照云端建成 WITHOUT ROWID；image() 导出整库，用来模拟时间点恢复。
 * 照 DO 的 SQL 上限设 SQLite 的限制：单个字符串、BLOB 或一行 2 MB，一条语句 100 KB，绑定参数 100 个，超过就抛错，与平台一样
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/（SQL storage limits）
 */
export function cloudStorage(...schema: string[]) {
  const db = open(schema.map((statement) => `${statement} WITHOUT ROWID`));
  const { capi } = sqlite3;
  capi.sqlite3_limit(db, capi.SQLITE_LIMIT_LENGTH, valueBytes);
  capi.sqlite3_limit(db, capi.SQLITE_LIMIT_SQL_LENGTH, 100_000);
  capi.sqlite3_limit(db, capi.SQLITE_LIMIT_VARIABLE_NUMBER, 100);
  return asStorage(db);
}

/** 设备一侧：Rust 的内存设备库，先执行给的语句；image() 导出整库，当作系统备份 */
export const deviceStorage = rustStorage;

function open(schema: string[]) {
  const db = new sqlite3.oo1.DB(':memory:');
  for (const statement of schema) db.exec(statement);
  return db;
}

/** 从系统备份恢复出的设备库 */
export const restoredDeviceStorage = restoredRustStorage;

/** 从备份恢复出的库：云端时间点恢复，或读一份设备的系统备份 */
export function restoredStorage(image: Uint8Array) {
  const { capi, oo1, wasm } = sqlite3;
  const db = new oo1.DB(':memory:');
  const flags = capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE;
  db.checkRc(capi.sqlite3_deserialize(db, 'main', wasm.allocFromTypedArray(image), image.byteLength, image.byteLength, flags));
  return asStorage(db);
}

/**
 * 包成 Storage：image() 导出整库；每条语句的结果照 DO 的带上写了几行（rowsWritten，按 SQLite 改到的行数算，不含索引）；sql.databaseSize 照 DO 的是库文件多大（页数乘页大小）
 * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/（databaseSize）
 */
function asStorage(db: Database) {
  const storage = sqliteWasmStorage(sqlite3, db);
  const exec = storage.sql.exec;
  const sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const before = sqlite3.capi.sqlite3_total_changes(db);
      const cursor = exec(query, ...bindings);
      return { ...cursor, rowsWritten: sqlite3.capi.sqlite3_total_changes(db) - before };
    },
    get databaseSize() {
      return Number(db.selectValue('PRAGMA page_count')) * Number(db.selectValue('PRAGMA page_size'));
    },
  };
  return { ...storage, sql, image: () => sqlite3.capi.sqlite3_js_db_export(db) };
}

/**
 * 下一条以 prefix 开头的语句出错一次（磁盘满、进程在两句之间被杀），之后照常：查写到一半出错时留没留下半份。
 * Rust 的设备里 SQLite 在它改行之前中断（写语句时整个事务回滚：真的 I/O 错的一种结果，另一种是只撤这一句），错认得出（{@link injectedError}）
 */
export function failOnce<S extends ReturnType<typeof deviceStorage>>(storage: S, prefix: string) {
  storage.database.inject(JSON.stringify({ prefix }));
  return storage;
}

/** 注入的存储故障（云端的存储出错）：测试据此分清是自己注入的还是真出了错 */
export class InjectedFault extends Error {
  /** 第 sql 句出的错（当作 I/O 错） */
  constructor(sql: string) {
    super(`${injectedPrefix}${sql.slice(0, 40)} 句出错`);
  }
}

/** 注入的故障的消息都以它开头：照常报出的错里认得出哪些是注入的 */
export const injectedPrefix = 'SQLITE_IOERR: 注入的故障，第 ';

/** 设备上注入的错的消息：SQLite 的中断（测试里只有注入会中断语句） */
export const injectedError = /Error code 9: interrupted/;

/** 是不是注入的故障（云端的 InjectedFault，设备上 SQLite 的中断）：Drizzle 把驱动的错包进 DrizzleQueryError 的 cause 里，顺着 cause 找 */
export function isInjected(error: unknown): boolean {
  return (
    error instanceof InjectedFault ||
    (error instanceof Error && (error.message.startsWith('Error code 9: ') || (error.cause !== undefined && isInjected(error.cause))))
  );
}

/**
 * 可以随时注入故障的设备库：arm(after) 之后第 after 条读写语句（不算开关事务的 SAVEPOINT、RELEASE、ROLLBACK）以 SQLite 的中断失败，
 * 抛过一次就不再抛；disarm 取消。在 Rust 里数语句（见 failOnce）
 */
export function faultable(storage: ReturnType<typeof deviceStorage>) {
  return {
    storage,
    arm: (after: number) => storage.database.inject(JSON.stringify({ after })),
    disarm: () => storage.database.inject('null'),
  };
}

/** 数执行了几条语句：take 给出从上次 take 起的条数与各条的 SQL */
export function countStatements(storage: { sql: { exec: ReturnType<typeof cloudStorage>['sql']['exec'] } }) {
  let seen: string[] = [];
  const exec = storage.sql.exec;
  storage.sql.exec = (sql: string, ...bindings: unknown[]) => {
    seen.push(sql);
    return exec(sql, ...bindings);
  };
  return {
    take() {
      const taken = seen;
      seen = [];
      return taken;
    },
  };
}

/** 记下一条语句读出来的至多多少行、多少字符（值按字符串计）：查一次读进内存的量有没有界 */
export function measureReads(storage: { sql: { exec: ReturnType<typeof cloudStorage>['sql']['exec'] } }) {
  const read = { rows: 0, chars: 0 };
  const exec = storage.sql.exec;
  storage.sql.exec = (sql: string, ...bindings: unknown[]) => {
    const cursor = exec(sql, ...bindings);
    return {
      ...cursor,
      toArray: () => {
        const rows = cursor.toArray();
        const chars = rows.reduce(
          (total, row) => total + Object.values(row).reduce((sum: number, value) => sum + String(value).length, 0),
          0,
        );
        read.rows = Math.max(read.rows, rows.length);
        read.chars = Math.max(read.chars, chars);
        return rows;
      },
    };
  };
  return read;
}
