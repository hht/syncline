import { readRows } from '../common/limits.ts';
import { isProgress } from '../common/parse.ts';
import type { Chunk, Cookie, Poke, Progress, Reset, Value } from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import { quote } from '../common/sql.ts';
import type { Query } from '../common/storage.ts';
import { rowId } from '../tables/keys.ts';
import { bucketsAs, type TableReads } from './batches.ts';
import type { BucketRows, Tally } from './bucket-rows.ts';
import type { BucketRules, Buckets, Subscription } from './buckets.ts';
import { type Commits, changedRows, type Keys } from './commits.ts';
import { landedAt, type Position } from './position.ts';
import type { Begun, Reader } from './reader.ts';

/**
 * 共用空间怎么按订阅给块与发给分片的一轮：读取器按设备的订阅读，
 * 块要能让订阅相同的设备共用：请求带游标与落地时的订阅（landed，末块给的、设备原样带回），分块中途另带位置；计划的订阅与这次的不同（令牌换了）
 * 就从游标与落地的订阅重起：去掉了桶就整份，加了桶只扫新加的桶（model/Shared.tla 的 Start）。整份的水位取最近的块边界、增量的取它与游标中较大的，
 * 同一段时间里起拉的设备落在同一串网址上；游标不在当前历史上、cursor 认不出（伪造、清空重建过、截日志截过了）回 reset，设备清空重下。
 * 每块带 seen（算这一块时的最新一版）；末块另带 next（落在末块那一版的位置）与按的订阅：末块可能是缓存里过时的副本，设备发现它比暂存的块早时
 * 从 next 接着拉、带上下限。整份下载的中间块带进度：总共是第一块时订阅里各桶的行数之和，已下是扫过的行，随 cursor 带着
 * （同一串网址上的块进度也相同）；行数还没数完的整次下载不带。写的时候提交记录的每一项带着这一行改前与改后在的桶，发给分片的一轮据此按连接的订阅筛。
 * 不该知道的：写怎么执行与记、块怎么经缓存发出、怎么发给分片、分片怎么推。
 * @see https://electric-sql.com/docs/api/http
 * @see https://docs.powersync.com/architecture/powersync-protocol
 */

/** 共用空间的设置：桶规则；每满 chunkRows 行（改到的行）一个块边界，整份的水位对齐到它 */
export type Shared = { buckets: BucketRules; chunkRows?: number };

/** 共用空间默认每满几行（改到的行）一个块边界：后台持续写时，整份的水位约这么多行换一次，其间新装的设备共用缓存的块 */
export const defaultRows = 1000;

/**
 * 服务端的写里每一项带上改前在的桶：改前读，删的在 RETURNING 里按删掉前的值算（连带删的也是）；
 * 同一行在这次写里改了几次的，writeOnServer 按第一次被改之前的算
 */
export const bucketsBefore = (buckets: Buckets, query: Query) => ({
  before: (table: string, key: Record<string, Value>) => buckets.now(query, [[table, key]])(table, key),
  readback: {
    columns: (name: string) => `${buckets.membership(name)} AS ${quote(bucketsAs)}`,
    before: (row: Record<string, Value>) => buckets.idsOf(row[bucketsAs]),
  },
});

/** 共用空间给出的块与重置报给谁 */
type SharedReport = { reset: (cookie: Cookie | null) => void; pulled: <T extends Poke | Chunk>(chunk: T, chars: number) => T };

/** 共用空间一台设备的订阅：规范写法（至多 subscriptionBytes 字节，放得进连接的附带数据）与它的指纹 */
export type Subscribed = { subscription: Subscription; sub: string };

/** 落地时的订阅怎么放进网址：规范写法的 JSON 编成 base64url（网址里的长度至多 4/3 倍，不像转义那样随字符变） */
const encodeLanded = (subscription: Subscription) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(subscription))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/** 设备带回的落地时的订阅；认不出（伪造、损坏）是 undefined，当作没有（整份） */
function decodeLanded(text: string | undefined): Subscription | undefined {
  if (text === undefined) return undefined;
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    const value: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    return Array.isArray(value) && value.every((bucket) => typeof bucket === 'string') ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 共用空间从哪读起：带着的位置认得出、按的还是这份订阅就接着读；按的不是这份订阅（或没有位置）就从游标与落地的订阅新起：
 * 没有游标、落地的订阅认不出或去掉了桶就整份，否则增量，第一轮另扫新加的桶。游标或位置认不出是 undefined（回 reset）
 */
function beginShared(commits: Commits, reader: Reader, { cookie, cursor, landed }: PullRequest, { subscription, sub }: Subscribed) {
  if (cookie && !commits.onHistory(cookie)) return undefined;
  const resumed = cursor === undefined ? undefined : reader.resume(cursor);
  if (cursor !== undefined && !resumed) return undefined;
  // 新加的桶：订阅里有、落地的订阅里没有的（接着读的第一轮也要，每个请求都带着落地的订阅）
  const before = decodeLanded(landed);
  const added = new Set(before ? subscription.filter((bucket) => !before.includes(bucket)) : []);
  if (resumed?.sub === sub) return { position: resumed, fresh: false, carried: resumed.carried, added };
  const watermark = commits.watermark();
  const now = new Set(subscription);
  if (!cookie || !before?.every((bucket) => now.has(bucket)))
    return { position: { ...reader.start(null, watermark), sub }, fresh: true, added };
  const position: Position = {
    ...reader.start(cookie, watermark.version > cookie.version ? watermark : cookie),
    sub,
    ...(added.size > 0 && { added: true as const }),
  };
  return { position, fresh: true, added };
}

/** 共用空间拉一块：subscribed 是设备的订阅，另带桶规则（buckets）与每个桶的行数（rows），一块至多给 limit 个字符的改动 */
export function pullShared(
  commits: Commits,
  reader: Reader,
  request: PullRequest,
  subscribed: Subscribed & { buckets: Buckets; rows: BucketRows },
  limit: number,
  report: SharedReport,
): Poke | Chunk | Reset {
  const { cookie, cursor } = request;
  const { buckets, rows, subscription, sub } = subscribed;
  // 都带上订阅的指纹与空间的这一代：设备带着目标作下限时据此认出目标是不是这一代
  const origin = { sub, incarnation: commits.incarnation() };
  const begun = beginShared(commits, reader, request, subscribed);
  if (!begun) {
    // 共用空间的设备只读、没有待上传：cursor 认不出就回 reset，设备清空重下
    report.reset(cookie);
    return { base: cookie, reset: true, ...origin };
  }
  // 整份新起时算总共（私有空间的按字节估）
  const { total, read: counted } = begun.fresh && begun.position.full ? rows.total(subscription) : { total: undefined, read: 0 };
  let progressed: Progress | undefined;
  const read = reader.read(
    begun satisfies Begun,
    { rows: readRows - counted, chars: limit },
    {
      visible: { buckets, subscription, added: begun.added },
      carry: ({ scanned, full, carried }) => {
        const before = isProgress(carried) ? carried : total === undefined ? undefined : { downloaded: 0, total };
        if (!full || !before) return undefined;
        const downloaded = before.downloaded + scanned;
        progressed = { downloaded, total: Math.max(before.total, downloaded) };
        return progressed;
      },
    },
  );
  const seen = commits.head().version;
  const continued = cursor === undefined ? {} : { cursor };
  if ('next' in read)
    return report.pulled(
      { base: cookie, ...continued, next: read.next, patch: read.ops, seen, ...(progressed && { progress: progressed }), ...origin },
      read.chars,
    );
  const final = { cookie: read.at, lmids: {}, patch: read.ops, seen, next: landedAt(read.at, sub), landed: encodeLanded(subscription) };
  return report.pulled({ base: cookie, ...continued, ...final, ...origin }, read.chars);
}

/**
 * 共用空间发给广播分片的一轮：base 之后到 cookie 改到的行，分片按每条连接的订阅筛（rows 的每一行：改前或改后在订阅的桶里才给，现在在就给值、
 * 不在了给删除）。没有 rows 是改到的太多、有不带键的一版（规则变了、表进出同步）或 base 不在当前历史上：分片只发提示，设备连着 HTTP 拉取（经缓存）。
 * incarnation 是空间的这一代（第 0 版的随机数，清空重建后不同）
 */
export type Round = { base: Cookie; cookie: Cookie; incarnation: number; rows?: RoundRow[] };

/** 一轮里改到的一行：row 是现在的值（不在了没有），now 是它现在在的桶，touched 是这段时间里改前或改后在的桶（都是规范写法） */
type RoundRow = { table: string; key: Record<string, unknown>; row?: Record<string, unknown>; now: string[]; touched: string[] };

/** 一轮里改到的一行：表、主键与这段时间里改前或改后在的桶 */
type RoundTouch = { table: string; key: Record<string, unknown>; buckets: Set<string> };

/**
 * base 之后到最新一版改到的行（按行合并，带着各项记下的桶）；读的提交超过 readRows 行、有不带键的一版（规则变了、表进出同步）、
 * 有离开同步的表都给 undefined
 */
function touchedSince(commits: Commits, base: Cookie) {
  const head = commits.head().version;
  const touched = new Map<string, RoundTouch>();
  let read = 0;
  for (let at = base.version; at < head; ) {
    const batch = commits.after(at);
    read += batch.read;
    if (read > readRows || batch.commits.length === 0) return undefined;
    for (const { cookie, keys } of batch.commits) {
      if (!merge(touched, keys)) return undefined;
      at = cookie.version;
    }
  }
  return [...touched.values()];
}

/** 一版的各项并进 touched（同一行合并它记下的桶）；不带键的一版、离开同步的表并不进，是 false */
function merge(touched: Map<string, RoundTouch>, keys: Keys) {
  if (keys.length === 0 || keys.some(([, key]) => key === null)) return false;
  for (const [table, key, names = []] of keys) {
    const row = key as Record<string, unknown>;
    const known = touched.get(rowId(table, row)) ?? { table, key: row, buckets: new Set<string>() };
    for (const bucket of names) known.buckets.add(bucket);
    touched.set(rowId(table, row), known);
  }
  return true;
}

/**
 * 共用空间发给广播分片的一轮里改到的行：base 之后到最新一版改到的每一行，现在的值、现在在的桶与这段时间里改前或改后在的桶
 * （提交记录的项带着），分片按每条连接的订阅筛。读不全（touchedSince）、这段提交记录的主键超过 limit 字节、行的 JSON 超过 limit 个字符、base 不在当前历史上，都给 undefined：
 * 分片只发提示，设备去拉
 */
export function sharedRound(commits: Commits, tables: TableReads, buckets: Buckets, query: Query, base: Cookie, limit: number) {
  if (!commits.onHistory(base)) return undefined;
  // 这段提交记录的主键（累计字节相减）就超过上限：不读进内存（同一行改了很多次也算，那时只发提示，设备去拉）
  if (commits.bytesAt(commits.head().version) - commits.bytesAt(base.version) > limit) return undefined;
  const touched = touchedSince(commits, base);
  if (!touched) return undefined;
  const now = buckets.now(
    query,
    touched.map(({ table, key }): [string, Record<string, unknown>] => [table, key]),
  );
  const rows: RoundRow[] = [];
  let chars = 0;
  for (const { table, key, buckets: names } of touched) {
    const current = tables.current(table, key);
    const row: RoundRow = {
      table,
      key,
      ...(current.op === 'put' && { row: current.row }),
      now: now(table, key),
      touched: [...names].sort(),
    };
    chars += JSON.stringify(row).length;
    if (chars > limit) return undefined;
    rows.push(row);
  }
  return rows;
}

/** 共用空间写完时每一项并上它现在在的桶（改前的随这一项报出），改前、改后的桶报给 tally 增减各桶的行数 */
export function withBuckets(buckets: Buckets, query: Query, keys: Keys, tally: Tally): Keys {
  const now = buckets.now(query, changedRows(keys));
  return keys.map((entry) => {
    const [table, key, before = []] = entry;
    if (!key) return entry;
    const after = now(table, key);
    tally.add(table, key, before, after);
    return [table, key, [...new Set([...before, ...after])].sort()];
  });
}
