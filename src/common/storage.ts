/**
 * 云端要的同步 SQLite：取的是 Durable Object 的 ctx.storage 里用到的那部分，云端直接传 ctx.storage，测试里由替身包成这个样子。
 * Drizzle 的 durable-sqlite 驱动只靠这几个成员，服务端的写因此照常用 Drizzle。
 * 不该知道的：库文件在哪、用哪个驱动。
 * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
 */
export type Storage = {
  sql: { exec(query: string, ...bindings: unknown[]): Cursor };
  /** 在一个事务里同步执行 body，抛错就整体回滚 */
  transactionSync<T>(body: () => T): T;
};

/**
 * 云端一侧另要库文件多大（字节）：下载进度按它估，Durable Object 的 sql.databaseSize
 * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/（databaseSize）
 */
export type CloudStorage = Storage & { sql: { readonly databaseSize: number } };

/**
 * 拒收：设备推来的写引用的行已不在、改到的行不合声明（ValidationError）、改的表或列不是同步的时，云端照样记一条空提交、推进这个客户端的序号，
 * 设备撤回这条写。服务端的写抛它（或别的错）整条回滚，抛给调用方。是写本身的问题，原因里写着什么都不是存储出错（isTransient）
 */
export class Reject extends Error {}

/**
 * 云端的存储出的错是不是暂时的、重试会好：SQLite 的 BUSY、LOCKED、NOMEM、INTERRUPT、IOERR、FULL，与平台标了 retryable 的；其余（约束、类型不符、拒收、认不出的）
 * 每次执行都会再出。云端推送按它决定不推进还是扣下（设备一侧在 Rust 里判断）。workerd 把结果码写在消息末尾（「database or disk is full: SQLITE_FULL」），
 * 测试替身用的官方 WASM 写在开头（「SQLITE_FULL: sqlite3 result code 13: …」），都认
 * @see https://sqlite.org/rescode.html
 * @see https://github.com/cloudflare/workerd/blob/v1.20260930.2/src/workerd/util/sqlite.c%2B%2B（dbErrorMessage）
 * @see https://developers.cloudflare.com/durable-objects/best-practices/error-handling/（retryable）
 */
export function isTransient(error: unknown) {
  // 拒收的原因可以带着推来的列名、校验器报的值，恰有下面的字样也不是存储出错
  if (!(error instanceof Error) || error instanceof Reject) return false;
  return (error as { retryable?: unknown }).retryable === true || /\bSQLITE_(BUSY|LOCKED|NOMEM|INTERRUPT|IOERR|FULL)/.test(error.message);
}

export type Cursor = {
  /** 每行一个对象，键是 SQL 列名 */
  toArray(): Record<string, unknown>[];
  /** 按列排的行；next 给第一行（Drizzle 的 get 这样取） */
  raw(): { toArray(): unknown[][]; next(): { done?: false; value: unknown[] } | { done: true; value?: never } };
  /**
   * 这条语句写了几行，取完结果之后是计费用的值（含索引）：Durable Object 的游标有，设备一侧的驱动不给
   * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec（rowsWritten；写索引的每一行另算一行）
   */
  rowsWritten?: number;
};

/** 在调用方开好的事务里执行一条语句、取出全部行：各模块经它读写库，不碰驱动 */
export type Query = (sql: string, ...bindings: unknown[]) => Record<string, unknown>[];

export const queryOf =
  (storage: Storage): Query =>
  (sql, ...bindings) =>
    storage.sql.exec(sql, ...bindings).toArray();
