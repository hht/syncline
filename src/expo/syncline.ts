import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Change } from '../common/protocol.ts';
import type { Schema } from '../tables/table-definitions.ts';
import type { Validation } from '../tables/validation.ts';
import { remoteDatabase } from './remote-database.ts';
import type { SyncStatus } from './status.ts';

/**
 * App 用的 Syncline：一个本机库（私有空间加若干共用空间），读写用 Drizzle，看同步状态、手动同步，关库、删库。
 * 底下是 Client（三端一样，里面是 Rust 的设备），这里包成 App 用的样子。
 * 不该知道的：库在哪、怎么打开，同步怎么进行。
 */

export type { Schema } from '../tables/table-definitions.ts';

/** 本机读写用的 Drizzle 库（异步：库在别的线程上） */
export type Database = ReturnType<typeof remoteDatabase>;

type Execute = (sql: string, params: unknown[]) => Promise<unknown[][]>;

/** 被云端扣下的本机写：原因与原样的改动 */
export type Held = { reason: string; changes: Change[] };

/** 一个本机库要的（Client 给的） */
export type LocalDatabase = {
  query: Execute;
  tablesOf(sql: string): Promise<string[]>;
  write<T>(body: (execute: Execute) => Promise<T>): Promise<T>;
  onChange(listener: (tables: ReadonlySet<string>) => void): () => void;
  onHeld(listener: (writes: Held[]) => void): () => void;
};

/** 一个空间的同步（Client 给的） */
export type Channel = {
  status(): SyncStatus;
  onStatus(listener: (status: SyncStatus) => void): () => void;
  sync(options?: { signal?: AbortSignal }): Promise<void>;
  resync(options?: { signal?: AbortSignal; discardPending?: boolean }): Promise<void>;
  reconnect(): void;
};

/** 平台给的：开一个共用空间的同步、关库、删库 */
export type Platform = {
  shared(name: string, tables: SQLiteTable[], url: string, token: () => Promise<string>, owner?: string): Channel;
  close(): Promise<void>;
  delete(): Promise<void>;
};

/** 打开一个本机库要给的；validation 是表到 Standard Schema 的 Map，写的时候按它校验 */
export type OpenOptions<S extends Schema> = {
  /** 库的名字：文件是「名字.db」，一个 App 一个 */
  name: string;
  /**
   * 私有空间属于谁（登录的用户的 id）：和上次打开时不同，就先清掉上一个人的私有数据，共用空间照样留着。上一个人还有没上传的写时不清、打开出错
   * （PendingWrites，带着上一个人与条数），让他登录同步完再换人，或给 discardPending 连它们一起丢掉
   */
  owner?: string;
  /** 换了人时上一个人没上传的写也丢掉（见 owner）；syncOnce 不理它 */
  discardPending?: boolean;
  schema: S;
  /** 本机专用的表：同样照 Drizzle 建在这个库里，本机写可以和同步表一起写，不上传；换了人登录时清掉 */
  localOnly?: Schema;
  /** 删掉的同步表与列（「表.列」），与云端的 retired 相同：不再同步，打开时从库里删掉（有待上传也是：先撤回、删掉、再重放）；不能再声明 */
  retired?: string[];
  /** 私有空间的同步地址（https 开头） */
  url: string;
  /** 当前身份的 token，每次连接前调用 */
  token: () => Promise<string>;
  validation?: Validation;
  /** 只由云端写的同步表：设备只读，本机写改到就抛错 */
  readOnly?: SQLiteTable[];
  /** 在线校验和每天至多核对多少行（默认 100 万：云端当场算，每读一行计费） */
  checksumRowsPerDay?: number;
};

const channelOf = (channel: Channel) => ({
  /** 当前的同步状态 */
  status: () => channel.status(),
  /** 同步状态每次变了调用 listener；返回取消订阅 */
  onStatus: (listener: (status: SyncStatus) => void) => channel.onStatus(listener),
  /** 立即同步，等到补齐、本机的写都被确认；出错或 signal 中止时失败，同步照样在后台重试 */
  sync: (options?: { signal?: AbortSignal }) => channel.sync(options),
  /** 整份重新下载、换掉本机的数据；没上传的写留着、重下完照常推上去，discardPending 为真时连它们一起丢 */
  resync: (options?: { signal?: AbortSignal; discardPending?: boolean }) => channel.resync(options),
  /** 令牌变了（如权限变了，共用空间按令牌算的可见范围不同）：立刻换一条连接、重新取 token，如在 Firebase 的 onIdTokenChanged 里调 */
  reconnect: () => channel.reconnect(),
});

/** 把平台给的本机库与同步包成 App 用的样子 */
export function syncline(name: string, local: LocalDatabase, channel: Channel, platform: Platform, token: () => Promise<string>) {
  const db = remoteDatabase(local.query);
  /** 开过的共用空间，按名字：同样的再开一次给开着的那份（React 的 StrictMode 里 effect 跑两次） */
  const opened = new Map<string, { url: string; owner: string | undefined; channel: ReturnType<typeof channelOf> & { name: string } }>();
  return {
    name,
    /** 读：只读的 Drizzle 库 */
    db,
    /** 写：body 在一个本机事务里，tx 是可读可写的 Drizzle 库，读写多少条都行；抛错整条回滚。提交后同步表的改动自动上传 */
    write: <T>(body: (tx: Database) => Promise<T>) => local.write((execute) => body(remoteDatabase(execute))),
    /** 同步表与本机专用的表变了（本机写、收到云端改动、被重置）之后调用 listener，给出改到的表；返回取消订阅 */
    onChange: (listener: (tables: ReadonlySet<string>) => void) => local.onChange(listener),
    /** 一条查询读哪些表（不执行） */
    tablesOf: (sql: string) => local.tablesOf(sql),
    /** 本机写被云端扣下时调用 listener，给出原因与原样的改动；返回取消订阅 */
    onHeld: (listener: (writes: Held[]) => void) => local.onHeld(listener),
    ...channelOf(channel),
    /**
     * 同一个库里的一个共用空间（只读）：schema 的表名不能与私有空间、别的共用空间重名；同样的（名字、地址、登录的人）再开一次给开着的那份；token 不给就用私有空间的；
     * 看得见哪些行由云端按 token 定（订阅的桶）。owner 是这次登录的人，和上次不同就先清掉上一个人看过的数据，不留给看不到它的人。读照常用 db，onChange 一起报
     */
    shared: (sharedName: string, options: { schema: Schema; url: string; token?: () => Promise<string>; owner?: string }) => {
      const known = opened.get(sharedName);
      if (known?.url === options.url && known.owner === options.owner) return known.channel;
      if (known) throw new Error(`共用空间 ${sharedName} 已经按别的地址或登录的人开着`);
      const shared = {
        name: sharedName,
        ...channelOf(platform.shared(sharedName, Object.values(options.schema), options.url, options.token ?? token, options.owner)),
      };
      opened.set(sharedName, { url: options.url, owner: options.owner, channel: shared });
      return shared;
    },
    /** 停下同步、关库；之后不能再读写 */
    close: () => platform.close(),
    /** 关库并删掉库文件（清除本机数据） */
    delete: () => platform.delete(),
  };
}

export type Syncline = ReturnType<typeof syncline>;
