import { runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { readRows } from '../common/limits.ts';
import type { CloudStorage, Cursor } from '../common/storage.ts';

// 规模门禁的计量：在真的 Durable Object 里包一层存储，按 DO 游标的 rowsRead（计费用的读行数）统计一次请求读了多少行。
// 数据直接用 SQL 铺在没包的存储上，不计读数；表是 TestSpace 的（对象里已经建好，在它的存储上开 Space 不改同步范围）

/** 一次请求的上界：一块的读预算（readRows），加上每次请求固定的几条语句（最新一版、各客户端处理到第几条、扣下的写）的余量 */
export const readBound = readRows + 2_000;

/** 铺的规模：上界的 10 倍，随它涨的读数一定越界 */
export const scale = 10 * readBound;

/** 读了多少行：total 是全部语句之和；reset 清零，从这里开始量 */
export type Reads = { total: number; reset(): void };

/**
 * 包住 DO 的存储，统计取走的游标的 rowsRead（取完结果之后才是准的，逐行取时每取一行补上增量）
 * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec（rowsRead）
 */
function metered(storage: DurableObjectStorage) {
  const reads: Reads = {
    total: 0,
    reset() {
      reads.total = 0;
    },
  };
  const exec = (sql: string, ...bindings: unknown[]): Cursor => {
    const cursor = storage.sql.exec(sql, ...(bindings as SqlStorageValue[]));
    let counted = 0;
    const count = <T>(result: T) => {
      const delta = cursor.rowsRead - counted;
      counted = cursor.rowsRead;
      reads.total += delta;
      return result;
    };
    // 不取结果的语句（Drizzle 的 run()）也计上执行时读的
    count(undefined);
    return {
      toArray: () => count(cursor.toArray()),
      raw: () => {
        // workerd 的 raw() 也有 toArray（Drizzle 的 durable-sqlite 驱动这样取），类型声明里没写
        const rows = cursor.raw() as unknown as ReturnType<Cursor['raw']>;
        return { toArray: () => count(rows.toArray()), next: () => count(rows.next()) };
      },
      get rowsWritten() {
        return cursor.rowsWritten;
      },
    };
  };
  const wrapped: CloudStorage = {
    sql: {
      exec,
      get databaseSize() {
        return storage.sql.databaseSize;
      },
    },
    transactionSync: (body) => storage.transactionSync(body),
  };
  return { storage: wrapped, reads };
}

/** 在对象 stub 里跑 body：raw 是没包的存储（铺数据用），storage 是包过的（开 Space 用），reads 统计 storage 上的读 */
export function measured<T>(
  stub: DurableObjectStub,
  body: (context: { raw: DurableObjectStorage; storage: CloudStorage; reads: Reads }) => T,
): Promise<T> {
  return runInDurableObject(stub, (_, state) => body({ raw: state.storage, ...metered(state.storage) }));
}

/** 一条语句铺 count 行：columns 是 SELECT 的列表达式，i 是第几行（从 1 起） */
export function fillRows(raw: DurableObjectStorage, table: string, count: number, columns: string) {
  raw.sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO "${table}" SELECT ${columns} FROM n`,
    count,
  );
}

/**
 * 一条语句铺 count 次提交，接在最新一版之后：主键项是 SQL 表达式 keys（i 是第几次），累计字节照它接着往上加；给了 client 就当作它的写，
 * 照设备的写记上当天写了几行（第 i 次 3i 行），客户端表记它处理到第 count 条
 */
export function fillCommits(raw: DurableObjectStorage, count: number, keys: string, client?: string) {
  const head = raw.sql
    .exec<{ version: number; bytes: number }>('SELECT version, bytes FROM _syncline_commit ORDER BY version DESC LIMIT 1')
    .one();
  const [day, used] = client === undefined ? ['NULL', 'NULL'] : [String(Math.floor(Date.now() / 86_400_000)), '3 * i'];
  raw.sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO _syncline_commit (version, nonce, keys, day, used, bytes, client)
     SELECT ? + i, abs(random() % 9007199254740992), ${keys}, ${day}, ${used}, ? + sum(octet_length(${keys})) OVER (ORDER BY i), ? FROM n`,
    count,
    head.version,
    head.bytes,
    client ?? null,
  );
  if (client !== undefined)
    raw.sql.exec('INSERT INTO _syncline_client VALUES (?, ?) ON CONFLICT (client) DO UPDATE SET lmid = excluded.lmid', client, count);
}

/** 一次请求读的行数不超过上界 */
export const expectBounded = (rows: number, what: string) =>
  expect(rows, `${what}：读了 ${rows} 行，上界 ${readBound}`).toBeLessThanOrEqual(readBound);
