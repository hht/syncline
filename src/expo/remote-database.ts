import { drizzle } from 'drizzle-orm/sqlite-proxy';

// 本机写里怎么用 Drizzle：交下去执行的 execute 包成 Drizzle 的库。不该知道的：同步

/** 本机写里执行一条 SQL，返回按列排的行 */
export type Execute = (sql: string, params: unknown[]) => unknown[][];

/** 把 execute 包成 Drizzle 的异步库（sqlite-proxy）：本机写里照常用 Drizzle 读写；execute 可以是异步的（web 上隔着 Worker） */
export const remoteDatabase = (execute: (sql: string, params: unknown[]) => unknown[][] | Promise<unknown[][]>) =>
  drizzle(async (sql, params, method) => {
    const rows = await execute(sql, params);
    // get 要的是那一行本身，没有行时给 undefined（Drizzle 的 mapGetResult 照样处理），类型声明里没写
    return { rows: method === 'get' ? (rows[0] as unknown[]) : rows };
  });
