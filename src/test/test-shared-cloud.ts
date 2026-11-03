import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Broadcast } from '../cloud/broadcast.ts';
import { type Bucket, type BucketRules, bucketId } from '../cloud/buckets.ts';
import { Fanout } from '../cloud/fanout.ts';
import type { Round } from '../cloud/shared.ts';
import { Space } from '../cloud/space.ts';
import type { Cookie } from '../common/protocol.ts';
import { parsePullRequest } from '../common/pull-url.ts';
import { subscribed } from './test-catalog.ts';
import type { Cloud, CloudEnd, Network } from './test-network.ts';
import { picker } from './test-skeleton.ts';
import { cloudStorage } from './test-storage.ts';

// 共用空间模拟里的云端：真的共用空间 Space 与一个广播分片 Broadcast，HTTP 拉取另经一个替身缓存；
// 后台写、发给分片的一轮（没送到的照退避重发）、部署改桶规则、分片重启与被逐出内存、共用空间清空重建、设备的令牌换了（订阅变了）、
// 后台数每个桶的行数的一步。什么时候发生由模拟挑

export const program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull(), title: text().notNull(), team: text() });
export const createProgram = 'CREATE TABLE program (id TEXT PRIMARY KEY, status TEXT NOT NULL, title TEXT NOT NULL, team TEXT)';

/** 每次部署的桶规则：公开的条件在两者之间来回改；另有全部的桶与按 team 分的桶 */
const definitions: BucketRules[] = [
  { public: { program: { where: "status = 'published'" } }, all: { program: {} }, team: { program: { by: ['team'] } } },
  { public: { program: { where: "status IN ('published', 'featured')" } }, all: { program: {} }, team: { program: { by: ['team'] } } },
];

/** 令牌给的几种订阅：彼此之间有加桶、去桶、既加又去 */
const buckets: Record<string, Bucket[]> = {
  public: [['public']],
  admin: [['all']],
  teamA: [['team', 'a']],
  publicA: [['public'], ['team', 'a']],
  teams: [
    ['team', 'a'],
    ['team', 'b'],
  ],
};
export const subscriptionNames = Object.keys(buckets);
/** 一份订阅的桶与它编成的订阅 */
export const bucketsOf = (name: string) => buckets[name] ?? [];
export const subscriptionOf = (name: string) => subscribed(...bucketsOf(name));

const keys = Array.from({ length: 12 }, (_, index) => `p${String(index).padStart(2, '0')}`);
const statuses = ['draft', 'published', 'featured'];
const teams = ['a', 'b', null];

/** 发给分片的一轮里改到的行最多这么多字符；拉取一块至多这么多字符：整份与增量都分好几块，各块可能是不同时刻算出、进了缓存的 */
const inlineLimit = 300;
const chunkChars = 120;
const chunkRows = 2;
/** 日志的上限：调小，几十次写就要截 */
const commitFloor = 1_500;

export type Row = { id: string; status: string; title: string; team: string | null };

/** 按 definition 的规则，subscription 这份订阅现在看得见的行 */
export function rowsOf(storage: ReturnType<typeof cloudStorage>, definition: BucketRules, subscription: Bucket[]) {
  const conditions = subscription.map(([rule, ...params]) => {
    const member = definition[rule]?.program;
    if (!member) return '0';
    const by = (member.by ?? []).map((column, index) => `${column} = '${String(params[index])}'`);
    return `(${[member.where ?? '1', ...by].join(' AND ')})`;
  });
  const where = conditions.length > 0 ? conditions.join(' OR ') : '0';
  return storage.sql.exec(`SELECT id, status, title, team FROM program WHERE ${where} ORDER BY id`).toArray() as Row[];
}

export class SharedCloud {
  /** 共用空间的库：清空重建时换成新的 */
  storage: ReturnType<typeof cloudStorage> = cloudStorage(createProgram);
  #deployed = 0;
  #space: Space;
  #broadcast: Broadcast<CloudEnd>;
  /** 发给分片（产品代码 Fanout，只有一个分片）：对象重启时换一个，内存里的进度随之没了 */
  #fanout!: Fanout;
  /** 全部分片确认到的那一版落的库（产品里存在共用空间的库里；null 是一轮也没发过）：清空重建时随库清掉 */
  #saved: Cookie | null = null;
  /** 替身缓存：网址与订阅 → 算过的应答，与它是不是存得久的中间块 */
  readonly #cache = new Map<string, { text: string; lasting: boolean }>();
  /** 故障停止了：通知都送到，缓存里只有中间块还在 */
  #calm = false;
  #titles = 0;
  /** 每台设备的令牌现在给的订阅（名字） */
  readonly subscriptions: string[];
  readonly #network: Network;
  readonly #random: () => number;
  readonly #pick: ReturnType<typeof picker>;
  /** 替身 Worker 转给的云端：连接交给分片，HTTP 拉取经缓存交给共用空间；设备由网址的最后一段认 */
  readonly endpoint: Cloud = {
    accept: (socket, target, expiresAt) =>
      this.#broadcast.accept(socket, parsePullRequest(target).cookie, expiresAt, this.#subscribedOf(target)),
    receive: (socket) => this.#broadcast.receive(socket),
    pull: (target) => this.#pull(target),
  };

  constructor(network: Network, random: () => number, subscriptions: string[]) {
    this.#network = network;
    this.#random = random;
    this.#pick = picker(random);
    this.subscriptions = subscriptions;
    this.#space = this.#open();
    this.#broadcast = this.#shard();
  }

  /** 故障停止：之后通知都送到，缓存只给存得久的中间块；落下的一轮随即补发 */
  calm() {
    this.#calm = true;
    this.deliver();
  }

  definition() {
    return definitions[this.#deployed] as BucketRules;
  }

  /** 最新一版 */
  head() {
    return this.#space.head();
  }

  /** 一行的分桶列在轨迹核对里的编号（model/TraceShared.tla 的 c）：status 与 team 的第几种编成 1–9，行不在是 0 */
  bucketColumn(id: string) {
    const [row] = this.storage.sql.exec('SELECT status, team FROM program WHERE id = ?', id).toArray();
    if (!row) return 0;
    return statuses.indexOf(String(row.status)) * teams.length + teams.indexOf((row.team as string | null) ?? null) + 1;
  }

  /** 空间的这一代 */
  incarnation() {
    return this.#space.round(0).incarnation;
  }

  /** 网址最后一段那台设备的令牌给的订阅 */
  #subscribedOf(target: URL) {
    return subscriptionOf(this.subscriptions[Number(target.pathname.split('/').at(-1))] as string);
  }

  /** 第 index 台设备的令牌换了：给另一份订阅，一半时候只加桶（有比它多桶的订阅时），加桶只扫新加的桶，要常走到 */
  resubscribe(index: number) {
    const now = new Set(bucketsOf(this.subscriptions[index] as string).map((bucket) => JSON.stringify(bucket)));
    const wider = subscriptionNames.filter((name) => {
      const next = bucketsOf(name).map((bucket) => JSON.stringify(bucket));
      return next.length > now.size && [...now].every((bucket) => next.includes(bucket));
    });
    this.subscriptions[index] = (wider.length > 0 && this.#random() < 0.5 ? this.#pick(wider) : this.#pick(subscriptionNames)) as string;
  }

  /**
   * 共用空间的对象（重新）启动：打开时规则改了就记一次重扫（最新一版比扇出进度新）；扇出换一个新的，从落库的那一版算起
   * （内存里的进度随重启没了）
   */
  #open() {
    // 库文件的大小报成 0：日志的上限就是 commitFloor，几十次写就要截
    const storage = this.storage;
    const sql = { exec: (query: string, ...bindings: unknown[]) => storage.sql.exec(query, ...bindings), databaseSize: 0 };
    const space = new Space({ ...storage, sql }, [program], { shared: { buckets: this.definition(), chunkRows }, commitFloor });
    this.#fanout = new Fanout(
      {
        shards: ['shard'],
        head: () => space.head(),
        round: (from, head) => space.round(inlineLimit, from ?? head),
        send: (_shard, round) => this.#send(round),
        failed: () => undefined,
        confirmed: (head) => {
          this.#saved = head;
        },
      },
      this.#saved,
    );
    return space;
  }

  /** 发一轮给分片：没故障时有时送不到，有时送到了确认却丢了（之后从更早的一版重发，分片收到重的、晚到的） */
  async #send(round: Round) {
    const fate = this.#calm ? 1 : this.#random();
    if (fate < 0.15) throw new Error('没送到');
    await this.#broadcast.notify(round);
    if (fate < 0.3) throw new Error('送到了，确认丢了');
  }

  /** 分片的对象（重新）启动：知道的没了，连接全断 */
  #shard() {
    return new Broadcast(this.#network.sockets(), async () => this.#space.round(inlineLimit));
  }

  /**
   * HTTP 拉取经替身缓存（规则同产品里的 Cache-Control，缓存键含订阅）：有算过的有时给旧副本；带下限、还没到下限算出的，带这一代、云端不在这一代的不进缓存。
   * 故障停止后照缓存时长：首个请求（一分钟）与末块（几秒）都过期了，中间块（一天）还给旧副本，设备要靠下限拉到新的
   */
  #pull(target: URL) {
    const subscription = this.#subscribedOf(target);
    const key = `${subscription.sub} ${target.search}`;
    const cached = this.#cache.get(key);
    if (cached && (cached.lasting || !this.#calm) && this.#random() < 0.5) return cached.text;
    const request = parsePullRequest(target);
    const chunk = this.#space.pullShared(request, subscription, chunkChars);
    const text = JSON.stringify(chunk);
    const early = request.atLeast !== undefined && !('reset' in chunk) && (chunk.seen ?? 0) < request.atLeast;
    const otherIncarnation = request.incarnation !== undefined && chunk.incarnation !== request.incarnation;
    const lasting = request.cursor !== undefined && !('reset' in chunk) && !('cookie' in chunk);
    if (!early && !otherIncarnation) this.#cache.set(key, { text, lasting });
    return text;
  }

  /** 分片还没跟上最新一版（要重发） */
  lagging() {
    return !this.#fanout.allAcked();
  }

  /** 发一轮（产品代码：有一轮在发时排一轮在后面） */
  deliver() {
    void this.#fanout.deliver();
  }

  /** 后台写：改或删一个计划（改值、在桶之间移动），随即发一轮 */
  write() {
    const base = this.#space.head();
    const id = this.#pick(keys) as string;
    this.#titles += 1;
    const status = this.#pick(statuses) as string;
    const team = this.#pick(teams) ?? null;
    this.#space.mutate((tx) => {
      if (this.#random() < 0.2) tx.delete(program, { id });
      else tx.upsert(program, { id, status, title: `t${this.#titles}`, team });
    }, 0);
    if (this.#space.head().version === base.version) return;
    this.deliver();
  }

  /**
   * 共用空间清空重建（换了对象、从头重新导入）：新的空库、对象重启（空的空间马上发一次最新一版），再导入几行（可以一行不导）；
   * 版本号从头记、随机数都是新的，分片记下的一轮还在（可能比现在的最新一版还新）。上一代落下的一轮不再重发
   */
  rebuild() {
    this.storage = cloudStorage(createProgram);
    this.#saved = null;
    this.#space = this.#open();
    this.deliver();
    const rows = Math.floor(this.#random() * 4);
    for (let row = 0; row < rows; row += 1) this.write();
  }

  /** 部署：桶规则改了，对象重启；分片的连接不断 */
  deploy() {
    this.#deployed = (this.#deployed + 1) % definitions.length;
    this.#space = this.#open();
    this.deliver();
  }

  /** 后台数每个桶的行数的一步：每步只数两行，与写、部署、清空重建交错 */
  count() {
    this.#space.bucketRows?.step(2);
  }

  /** 后台任务截日志的一步（模型的 Truncate）：游标、拉到一半的位置早于下限的设备收到 reset、从头整份 */
  truncate() {
    this.#space.truncate();
  }

  /** 数完每个桶的行数，与各桶现在看得见的行数对不上就抛错 */
  checkCounts() {
    const counts = this.#space.bucketRows;
    while (counts?.step(2));
    for (const bucket of new Set(Object.values(buckets).flat().map(bucketId))) {
      const counted = counts?.total([bucket]).total;
      const actual = rowsOf(this.storage, this.definition(), [JSON.parse(bucket) as Bucket]).length;
      if (counted !== actual) throw new Error(`桶 ${bucket} 记的行数 ${counted}，看得见的是 ${actual}`);
    }
  }

  restartShard() {
    this.#network.restart();
    this.#broadcast = this.#shard();
  }

  /** 分片休眠后被逐出内存：知道的没了，休眠的连接（与附带数据里推到的那一版）还在 */
  evictShard() {
    this.#broadcast = this.#shard();
  }
}
