import { drizzle } from 'drizzle-orm/durable-sqlite';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { writeRows } from '../common/limits.ts';
import { type Pushed, parseChanges } from '../common/parse.ts';
import { type Change, type Chunk, type Cookie, chunkLimit, type Poke, type Reset } from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import { type CloudStorage, isTransient, type Query, Reject } from '../common/storage.ts';
import { type Declaration, readOnlyIn, readOnlyOf, withoutRetired } from '../tables/declaration.ts';
import { prepareInternalTables } from '../tables/internal-tables.ts';
import { Rows } from '../tables/rows.ts';
import { type Validation, Validator } from '../tables/validation.ts';
import { BucketRows } from './bucket-rows.ts';
import { Buckets } from './buckets.ts';
import { type CommitContext, commitWrite } from './commit-write.ts';
import { Commits, type Keys, type Used } from './commits.ts';
import { DailyWrites } from './daily-writes.ts';
import { type Events, isolated, quiet } from './events.ts';
import { evolveOnOpen, reviseRules } from './evolution.ts';
import { HeldWrites, heldIn } from './held.ts';
import { pull, type SpaceChecksum } from './pulls.ts';
import { Reader } from './reader.ts';
import { writeOnServer } from './server-write.ts';
import { bucketsBefore, defaultRows, pullShared, type Round, type Shared, type Subscribed, sharedRound } from './shared.ts';
import type { Transaction } from './transaction.ts';
import { WrittenRows } from './written-rows.ts';

/**
 * 一个空间在云端怎么提交写、怎么下发改动，整个空间一个版本号；共用空间（shared）只由服务端写、按订阅的桶下发：
 * 每处理一条写记一行提交记录，记下这次改到的行，某版本之后改了什么从提交记录查；各客户端处理到第几条记在客户端表。
 * 设备的写与服务端的写（导入等）都这样提交，设备一律按增量收到。
 * 拉取分块，读到哪全在 cursor 里，云端不记：先扫描、再追尾巴，追到最新一版才是末块。行读的都是当前值，
 * 开始之后改过的行在尾巴里再给一次，所以设备把各块暂存到末块、一起生效，就等于末块那一版的云端。
 * 设备推来的写是它改到的行，按行写；服务端的写用 Transaction。
 * 同步的范围是设备的表：只下发交给 Syncline 的表与列，云端的表可以多出只在云端的列（可空，按行写与 Transaction 都只写给出的列，不碰它们），
 * 只在云端的表不交给 Syncline，服务端的写照常写它、不记进提交（设备的 schema 决定同步什么）。
 * 不该知道的：消息怎么传、身份与权限、接入方的业务。
 * @see https://doc.replicache.dev/strategies/per-space-version
 * @see https://zero.rocicorp.dev/llms.txt（zero-cache keeps clients up to date via logical replication）
 */

/** 发给在线设备的通知改动太多（超过 limit 字节，UTF-8），没拼：只有版本与确认，在线设备收到提示、走 HTTP 拉取 */
export type Oversized = Omit<Poke, 'patch'>;

/**
 * validation：接入方给表的 Standard Schema，改到的行再按它查；声明了同步不了的列（BLOB、bigint）就抛错。
 * shared：共用空间（只由后台写、设备只读、按订阅的桶下发、拉取经缓存发出）的桶规则与块边界的间隔。
 * retired：删掉的表与列（「表.列」），不再回到同步。readOnly：只由云端写的同步表，设备推来的写改到就扣下。
 * commitFloor：日志的上限至少多少字节（Commits，测试里调小）；checksum：拉取要的校验和怎么算，不给就不给校验和；
 * pushRows：一批推送至多写多少行（计费的行写，见 push；默认一次写的上限 writeRows，测试里调小）
 */
type SpaceOptions = {
  validation?: Validation;
  shared?: Shared;
  events?: Events;
  retired?: string[];
  readOnly?: SQLiteTable[];
  commitFloor?: number;
  checksum?: SpaceChecksum;
  pushRows?: number | undefined;
};

export class Space {
  readonly #storage: CloudStorage;
  readonly #rows: Rows;
  readonly #log: Commits;
  readonly #db;
  readonly #reader: Reader;
  readonly #held: HeldWrites;
  readonly #events: Events;
  readonly #checksum: SpaceChecksum | undefined;
  readonly #pushRows: number;
  readonly #daily = new DailyWrites(() => this.#log.used());
  readonly #query: Query = (sql, ...bindings) => this.#daily.count(this.#storage.sql.exec(sql, ...bindings));
  /** 共用空间的桶规则与每个桶有多少行（BucketRows，后台数、删的一步步由对象的外壳做）；私有空间没有 */
  readonly #buckets: Buckets | undefined;
  readonly bucketRows: BucketRows | undefined;
  /** 提交写要用到的（commitWrite） */
  readonly #context: CommitContext;
  /** 同步着的表结构与删掉的名字：判断设备兼不兼容、丢掉推来的写里改到已删的部分 */
  readonly declaration: Declaration;
  readonly retired: ReadonlySet<string>;
  /** 只由云端写的表的名字 */
  readonly #readOnly: ReadonlySet<string>;
  /** 打开时同步的范围变了、记了提交（表进入同步、桶规则改了等）：在那之前的最新一版，共用空间据此通知分片；没变是 undefined */
  readonly evolvedFrom: Cookie | undefined;

  constructor(storage: CloudStorage, tables: SQLiteTable[], options: SpaceOptions = {}) {
    const { validation, shared, events = quiet, retired, readOnly = [], commitFloor, checksum, pushRows = writeRows } = options;
    this.#readOnly = readOnlyOf(tables, readOnly);
    this.#events = isolated(events);
    this.#checksum = checksum;
    this.#pushRows = pushRows;
    this.#storage = storage;
    this.#rows = new Rows(tables);
    const validator = new Validator(tables, validation);
    // Drizzle 的参数写成 Workers 的 DurableObjectStorage 类型，它只用到 Storage 里的几个成员
    this.#db = drizzle(storage as unknown as Parameters<typeof drizzle>[0]);
    prepareInternalTables(storage);
    const chunkRows = shared && (shared.chunkRows ?? defaultRows);
    const query = this.#query;
    this.#log = new Commits(query, { chunkRows, commitFloor });
    this.#held = new HeldWrites(query);
    this.#reader = new Reader(query, tables, this.#log);
    const buckets = shared && new Buckets(tables, shared.buckets);
    buckets?.check(query);
    this.#buckets = buckets;
    const opened = this.#log.head();
    // 进入同步的表从下一版起重扫；桶规则改了，规则变了的表也重扫
    const record = (keys: Keys) => this.#log.record(keys);
    const evolved = evolveOnOpen(storage, query, tables, retired ?? [], opened.version === 0, record, this.#events);
    const counts = buckets && new BucketRows(storage, query, buckets, this.#reader.tables.order());
    this.bucketRows = counts;
    this.#context = { storage, commits: this.#log, query, rows: this.#rows, validator, buckets, bucketRows: counts };
    if (buckets) storage.transactionSync(() => counts?.restart(reviseRules(query, tables, buckets, record, new Set(evolved.entered))));
    this.declaration = evolved.declaration;
    this.retired = evolved.retired;
    this.evolvedFrom = this.#log.head().version === opened.version ? undefined : opened;
  }

  /**
   * 按顺序逐条执行一批写：已处理过的跳过；序号正好接在处理到的后面的照常执行。比那大、又标着是这个客户端本机最早的
   * 待上传（first）的跳号：处理到的跳到它之前、照常执行，与这条写同一个事务（时间点恢复回滚掉了它前面已确认的几条，模型的 Process）；
   * 写的身份（客户端，序号）一经生成永不改变，不靠设备重编序号接上。不看它在这批里是不是第一条：标记由设备照待上传算，一批不是前缀也不会误跳。
   * 其余来自未来的（前面还缺）跳过、报出 write.skipped，正常运行不会出现（P3）。执行出错与改动认不出的（Pushed 的 malformed，模型里与执行不了的一样）
   * 扣下、推进序号；存储出错这类暂时的错（isTransient）抛出，出错那条起不处理、不推进序号（P2），之前的写留着、随这一轮结束提交；存储严重出错（SQLite 回滚了整个事务）时 workerd 把对象标坏、重置，
   * 这次推送一起作废。这批在一轮同步代码里执行，隐式事务要让出这一轮之后、对象没坏才提交（startImplicitTxnImpl）；
   * 超出 CPU 或内存时平台中止并把对象标坏（IoContext::abort）。写的行（计费的，回滚的也算）累计到 pushRows 就停在这条之后，设备接着推剩下的（模型 HandlePush 只处理前缀的一支：
   * 不然几条连带删很多行的写一起超过 CPU 上限，整批作废、原样重推，永远推不上去）。有新提交时返回发给所有在线设备的通知（只确认已执行的）；
   * 给了 limit、改动的 JSON 超过它就不拼（Oversized），不白读改到的行
   * @see https://doc.replicache.dev/reference/server-push（ids greater than lastMutationID + 1 must be ignored）
   * @see https://github.com/cloudflare/workerd/blob/v1.20260930.2/src/workerd/util/sqlite.c%2B%2B（handleCriticalError）
   * @see https://github.com/cloudflare/workerd/blob/v1.20260930.2/src/workerd/io/actor-sqlite.c%2B%2B（onCriticalError、startImplicitTxnImpl、shutdown）
   * @see https://github.com/cloudflare/workerd/blob/v1.20260930.2/src/workerd/io/io-context.c%2B%2B（abort）
   */
  push(mutations: Pushed[]): Poke | undefined;
  push(mutations: Pushed[], limit: number): Poke | Oversized | undefined;
  push(mutations: Pushed[], limit = Number.POSITIVE_INFINITY): Poke | Oversized | undefined {
    const base = this.#log.head();
    let head = base;
    const written = new WrittenRows(limit);
    // 各客户端处理到第几条：查过的记着，一批里同一个客户端只查一次；executed 是这批里执行了的
    const known = new Map<string, number>();
    const executed = new Map<string, number>();
    const start = this.#daily.written;
    for (const mutation of mutations) {
      const { client, id, first } = mutation;
      const lmid = known.get(client) ?? this.#log.lmid(client);
      known.set(client, lmid);
      if (id <= lmid) continue;
      if (id > lmid + 1 && !first) {
        this.#events({ type: 'write.skipped', client, id, lmid });
        continue;
      }
      head = this.#daily.measure((used) => this.#apply(mutation, used, written));
      known.set(client, id);
      executed.set(client, id);
      if (this.#daily.written - start >= this.#pushRows) break;
    }
    if (executed.size === 0) return undefined;
    // 最新一版之后只有这批的提交：确认的就是这批里执行了的各客户端处理到的
    return this.#notify(base, head, { lmids: Object.fromEntries(executed), ...heldIn(this.#held.since(base.version)) }, written);
  }

  /** 执行设备的一条写（见 push），执行不了就扣下；used 是当天写了几行，记进它的提交记录。返回记下的最后一版 */
  #apply(mutation: Pushed, used: () => Used, written: WrittenRows): Cookie {
    const { client, id, changes } = mutation;
    try {
      // 改动认不出（设备的缺陷、版本不符）：不执行，与执行不了的一样扣下
      if ('malformed' in mutation) throw new Reject(mutation.malformed);
      const kept = withoutRetired(mutation.changes, this.retired, this.declaration, (names) =>
        this.#events({ type: 'values.dropped', client, id, names }),
      );
      const readOnly = readOnlyIn(kept, this.#readOnly);
      if (readOnly) throw new Reject(`${readOnly} 只由云端写，设备推来的写不能改它`);
      return written.record((touched) =>
        commitWrite(this.#context, client, id, (changed) => this.#rows.write(this.#query, kept, changed), { used, touched }),
      );
    } catch (error) {
      // 暂时的错不推进序号、设备退避后重推；其余每次执行都会再出，重试只会让这个客户端之后的写永远推不上去（照 Replicache：permanent error 记为处理过）
      if (isTransient(error)) throw error;
      // 执行不了：整条回滚后记一次不改行的提交、照样推进序号，原样的改动与原因扣下待修复
      const reason = error instanceof Error ? error.message : String(error);
      const held = commitWrite(
        this.#context,
        client,
        id,
        () => this.#held.add(this.#log.head().version + 1, { client, id, reason }, changes),
        { used },
      );
      this.#events({ type: 'write.held', client, id, reason });
      return held;
    }
  }

  /**
   * 服务端的写（导入、付费回调等，不经设备）：在一个事务里执行，记一次没有客户端的提交，返回发给所有在线设备的通知。
   * 外键与设备推来的写一样：删父行连带删子行；写完后还引用不在的行就抛 Reject。出错（含 Reject）整条回滚、不提交，抛给调用方。
   * 给了 limit、改动的 JSON 超过它就不拼通知（Oversized）：没有在线设备时给 0，导入一批几千行不在内存里留它们的值
   */
  mutate(write: (tx: Transaction) => void): Poke;
  mutate(write: (tx: Transaction) => void, limit: number): Poke | Oversized;
  mutate(write: (tx: Transaction) => void, limit = Number.POSITIVE_INFINITY): Poke | Oversized {
    const base = this.#log.head();
    const before = this.#buckets && bucketsBefore(this.#buckets, this.#query);
    const context = { db: this.#db, query: this.#query, rows: this.#rows, bucketsBefore: before };
    const written = new WrittenRows(limit);
    const head = written.record((touched) =>
      commitWrite(this.#context, null, null, (changed) => writeOnServer(context, write, changed), { parents: true, touched }),
    );
    return this.#notify(base, head, { lmids: {} }, written);
  }

  /** 拉一块，怎么切块由读取一侧的 pull 函数定；catchUp 是连上时的补齐 */
  pull(request: PullRequest, limit: number, catchUp = false): Poke | Chunk {
    const checksum = this.#checksum;
    const report = {
      databaseSize: () => this.#storage.sql.databaseSize,
      pulled: <T extends Poke | Chunk>(chunk: T, chars: number) => this.#pulled('private', chunk, chars),
      held: this.#held,
      ...(checksum && { checksum: (cursor: string, rows: number | undefined) => checksum(this.#reader.tables, cursor, rows) }),
    };
    return pull(this.#log, this.#reader, request, limit, report, catchUp);
  }

  /** 导出者（另一个消费者）读一块：不报拉取的事件，不是设备在拉 */
  poll(position: string | undefined, limit: number) {
    return this.#reader.poll(position, limit);
  }

  /**
   * 共用空间拉一块：subscribed 是设备的订阅（入口按令牌算出）与它的指纹，一块至多给 limit 个字符的改动；
   * 怎么切块由 pullShared 定。都带上订阅的指纹与空间的这一代
   */
  pullShared(request: PullRequest, subscribed: Subscribed, limit = chunkLimit): Poke | Chunk | Reset {
    const counts = { buckets: this.#shared(), rows: this.bucketRows as BucketRows };
    return pullShared(this.#log, this.#reader, request, { ...counts, ...subscribed }, limit, {
      reset: (cookie) => this.#events({ type: 'cookie.reset', version: cookie?.version ?? 0 }),
      pulled: (pulled, chars) => this.#pulled('shared', pulled, chars),
    });
  }

  /** 扣下的写（待修复），按扣下的先后：原样的改动、原因、记下它的版本与时刻；分页见 HeldWrites.list */
  held(batch?: { limit?: number; after?: number }) {
    return this.#held.list(batch);
  }

  /**
   * 重新提交一条扣下的写（修好数据或代码之后）：照设备推来时一样按行写，记一次没有客户端的提交，成功就不再扣着，
   * 返回发给所有在线设备的通知。changes 不给就用原样的改动（照推送一样解析：扣下时就认不出的，抛给调用方）；还执行不了就整条回滚、抛给调用方，照样扣着
   */
  resubmit(client: string, id: number, changes?: Change[]): Poke;
  resubmit(client: string, id: number, changes: Change[] | undefined, limit: number): Poke | Oversized;
  resubmit(client: string, id: number, changes?: Change[], limit = Number.POSITIVE_INFINITY): Poke | Oversized {
    // 只重新提交还扣着的：重新提交过的、从没扣下过的再执行一遍，会盖掉之后的写
    if (!this.#held.has(client, id)) throw new Error(`没有扣下这条写：${client} 的第 ${id} 条`);
    changes ??= parseChanges(this.#held.changes(client, id));
    // 重新提交的按设备推来的写算：改到只由云端写的表就抛错，服务端要改它用 mutate
    const readOnly = readOnlyIn(changes, this.#readOnly);
    if (readOnly) throw new Error(`${readOnly} 只由云端写，重新提交不能改它`);
    const base = this.#log.head();
    const written = new WrittenRows(limit);
    const head = written.record((touched) =>
      commitWrite(
        this.#context,
        null,
        null,
        (changed) => {
          this.#rows.write(this.#query, changes, changed);
          this.#held.remove(client, id);
        },
        { touched },
      ),
    );
    this.#events({ type: 'write.resubmitted', client, id });
    return this.#notify(base, head, { lmids: {} }, written);
  }

  /** 给出一块：报给接入方（行数与字符数；chars 是拼块时量过的，opChars 之和），原样返回 */
  #pulled<T extends Poke | Chunk>(space: 'private' | 'shared', chunk: T, chars: number): T {
    this.#events({ type: 'chunk.pulled', space, rows: chunk.patch.length, chars, last: 'cookie' in chunk });
    return chunk;
  }

  /** 共用空间的桶规则；不是共用空间抛错 */
  #shared() {
    if (!this.#buckets) throw new Error('不是共用空间');
    return this.#buckets;
  }

  commitsOverLimit() {
    return this.#log.overLimit(this.#storage.sql.databaseSize);
  }

  /** 截日志的一步（后台任务做）：返回还要不要接着截 */
  truncate() {
    return this.#storage.transactionSync(() => this.#log.truncate(this.#storage.sql.databaseSize));
  }

  /** 设备推来的写当天（UTC）写了几行：每天的上限按它拦 */
  pushedToday() {
    return this.#daily.today().rows;
  }

  head(): Cookie {
    return this.#log.head();
  }

  /** 游标在不在当前历史上：连接时带的游标不在就关掉连接，设备先经 HTTP 整份重拉 */
  onHistory(cookie: Cookie) {
    return this.#log.onHistory(cookie);
  }

  /**
   * 发给在线设备的通知：从 base 到 head（这次记下的最后一版），这次推送或服务端写改到的行写完后的值（WrittenRows，不回表读）；
   * 装不下就只有版本与确认（Oversized）
   */
  #notify(base: Cookie, head: Cookie, confirmed: Pick<Poke, 'lmids' | 'held'>, written: WrittenRows): Poke | Oversized {
    const update = { base, cookie: head, ...confirmed };
    const patch = written.ops();
    return patch ? { ...update, patch } : update;
  }

  /**
   * 共用空间发给广播分片的一轮：base 之后改到的行、它们现在在的桶与改前或改后在的桶，分片按每条连接的订阅筛；
   * 改到的太多（超过 limit 个字符）、有不带键的一版、base 不在当前历史上都不带行，分片只发提示。不给 base 就是最新一版、没有改动
   */
  round(limit: number, base = this.#log.head()): Round {
    const rows = sharedRound(this.#log, this.#reader.tables, this.#shared(), this.#query, base, limit);
    return { base, cookie: this.#log.head(), incarnation: this.#log.incarnation(), ...(rows && { rows }) };
  }
}
