import { cookie, isCount, isObject, isValues } from '../common/parse.ts';
import type { Cookie, PullRange } from '../common/protocol.ts';
import { canonicalKey, type Key } from '../tables/keys.ts';

// 读取器读到哪的位置怎么编成 cursor 的文本、怎么从文本认回来、设备带回的认不认得出：形状、主键的列、各版在不在当前历史上
// （怎么查由调用方给），伪造或损坏的一律认不出、不抛错。同一个位置只有一种写法（主键的列按名字排）：共用空间的入口照它重写设备带来的 cursor 作缓存键，
// 设备拿回显的 cursor 比对接不接得上。
// 不该知道的：怎么从位置往后读

/** 按范围重下的一张表：主键在 after 之后、不超过 until 的行（都没有是整张表） */
export type Range = { table: string; after?: Key; until?: Key };

/**
 * 读到哪：full 是以整份开头；round 是这一轮的 (from, to]，整份第一轮 from 为空；scan 是本轮还在扫的表、桶（共用空间按桶扫）与扫到的主键
 * （这张表或这个桶还没开始时没有 after），没有就是本轮扫完了；ranges 是设备要求重下的表与主键范围（只在增量的第一轮，按表名）；
 * sub 是共用空间这个计划按哪份订阅读（订阅的指纹，换了订阅就从设备落地的地方重起）；added 是这一轮另扫订阅里新加的桶（只在增量的第一轮）；
 * tail 是尾巴追到的一版与下一版已给了几项（一次提交可以切开）；seen 是算这一块时的最新一版（私有空间带着，接着读时核对它还在当前历史上：读到一半时间点恢复回滚过就认不出；落在 landedAt 的不带，导出接着读时补上；
 * 共用空间不带：同一个位置的网址不随算的时刻变，经缓存共用）；carried 是调用方要随 cursor 带着的（下载进度），原样带回
 */
export type Position = {
  full: boolean;
  round: { from: Cookie | null; to: Cookie };
  scan?: { table: string; bucket?: string; after?: Key };
  ranges?: Range[];
  sub?: string;
  added?: true;
  tail: { at: Cookie; index?: number };
  seen?: Cookie;
  carried?: unknown;
};

/** 扫到哪：表、桶与这张表或这个桶扫到的主键 */
export type Scan = NonNullable<Position['scan']>;

/** 扫描点的规范写法：字段按固定次序，主键是规范写法 */
const scanOf = ({ table, bucket, after }: Scan) => ({
  table,
  ...(bucket === undefined ? {} : { bucket }),
  ...(after && { after: canonicalKey(after) }),
});

/** 单独编成文本的扫描点：与位置里的 scan 同一种写法 */
export const encodeScan = (scan: Scan) => JSON.stringify(scanOf(scan));

/** 从文本认回扫描点：解析不了、形状不对、扫着的表还在同步却缺主键的列都是 undefined（认不出的从头扫，不抛错） */
export function decodeScan(text: string, key: Context['key']): Scan | undefined {
  try {
    const scan = parseScan(JSON.parse(text));
    return scan && fits(key, scan) ? scan : undefined;
  } catch {
    return undefined;
  }
}

/** 编成 cursor 的文本（设备原样带回）：字段按固定次序、主键的列按名字排，同一个位置只有一种写法 */
export function encodePosition({ full, round, scan, ranges, sub, added, tail, seen, carried }: Position) {
  const cookieOf = ({ version, nonce }: Cookie) => ({ version, nonce });
  return JSON.stringify({
    full,
    round: { from: round.from && cookieOf(round.from), to: cookieOf(round.to) },
    ...(scan && { scan: scanOf(scan) }),
    ...(ranges && {
      ranges: ranges.map(({ table, after, until }) => ({
        table,
        ...(after && { after: canonicalKey(after) }),
        ...(until && { until: canonicalKey(until) }),
      })),
    }),
    ...(sub === undefined ? {} : { sub }),
    ...(added && { added }),
    tail: { at: cookieOf(tail.at), ...(tail.index === undefined ? {} : { index: tail.index }) },
    ...(seen && { seen: cookieOf(seen) }),
    ...(carried === undefined ? {} : { carried }),
  });
}

/**
 * 读完、落在 cookie 那一版的位置（共用空间的末块给的 next，sub 是这个计划按的订阅；导出读完时存的位置）：这一轮的起点、水位与尾巴都是这一版，接着读时 cookie 之后
 * 有表进入就开下一轮，与从 cookie 新起增量的读法一样。末块是缓存里的过时的副本时，设备从这里接着拉
 */
export const landedAt = (cookie: Cookie, sub?: string) =>
  encodePosition({ full: false, round: { from: cookie, to: cookie }, ...(sub === undefined ? {} : { sub }), tail: { at: cookie } });

/** 规范写法：认得出的位置重写成 encodePosition 的写法，认不出的是 undefined */
export function canonicalPosition(text: string) {
  const position = decodePosition(text);
  return position && encodePosition(position);
}

/** 从文本认回位置；解析不了、形状不对是 undefined（伪造或损坏的 cursor 一律认不出，不抛错） */
export function decodePosition(text: string): Position | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!isObject(value) || typeof value.full !== 'boolean' || !isObject(value.round)) return undefined;
    const { round } = value;
    const tail = parseTail(value.tail);
    const scan = value.scan === undefined ? undefined : parseScan(value.scan);
    const ranges = value.ranges === undefined ? undefined : parseRanges(value.ranges);
    const plan = parsePlan(value);
    if (!tail || scan === null || ranges === null || !plan) return undefined;
    return {
      full: value.full,
      round: { from: round.from === null ? null : cookie(round.from), to: cookie(round.to) },
      ...(scan && { scan }),
      ...(ranges && { ranges }),
      ...plan,
      tail,
      ...(value.seen === undefined ? {} : { seen: cookie(value.seen) }),
      ...(value.carried === undefined ? {} : { carried: value.carried }),
    };
  } catch {
    return undefined;
  }
}

/** 共用空间的计划按的订阅与这一轮是否另扫新加的桶；形状不对是 undefined */
function parsePlan({ sub, added }: Record<string, unknown>): Pick<Position, 'sub' | 'added'> | undefined {
  if ((sub !== undefined && typeof sub !== 'string') || (added !== undefined && added !== true)) return undefined;
  return { ...(sub === undefined ? {} : { sub }), ...(added === true && { added }) };
}

/** 尾巴的位置；形状不对是 undefined（cookie 解析不了照样抛，由 decodePosition 接住） */
function parseTail(tail: unknown): Position['tail'] | undefined {
  if (!isObject(tail) || (tail.index !== undefined && !isCount(tail.index))) return undefined;
  return { at: cookie(tail.at), ...(tail.index === undefined ? {} : { index: tail.index }) };
}

/** 扫描的位置；形状不对是 null */
function parseScan(scan: unknown): Position['scan'] | null {
  if (!isObject(scan) || typeof scan.table !== 'string' || (scan.after !== undefined && !isValues(scan.after))) return null;
  if (scan.bucket !== undefined && typeof scan.bucket !== 'string') return null;
  return { table: scan.table, ...(scan.bucket === undefined ? {} : { bucket: scan.bucket }), ...(scan.after ? { after: scan.after } : {}) };
}

/** 重下的范围；形状不对是 null */
function parseRanges(ranges: unknown): Range[] | null {
  if (!Array.isArray(ranges)) return null;
  const parsed = ranges.map((range: unknown) => {
    if (!isObject(range) || typeof range.table !== 'string') return null;
    const { after, until } = range;
    if ((after !== undefined && !isValues(after)) || (until !== undefined && !isValues(until))) return null;
    return { table: range.table, ...(after === undefined ? {} : { after }), ...(until === undefined ? {} : { until }) };
  });
  return parsed.every((range) => range !== null) ? (parsed as Range[]) : null;
}

/** 核对一个位置要的：一版在不在当前历史上，一张同步表的主键的列（不是同步表是 undefined） */
export type Context = { onHistory: (cookie: Cookie) => boolean; key: (table: string) => string[] | undefined };

/** 一段的起或止：没有，或有这张同步表主键的每一列 */
const keyed = (key: Context['key'], table: string, bound: Key | undefined) =>
  bound === undefined || (key(table)?.every((column) => column in bound) ?? false);

/** 扫描点合不合这张表的主键：扫着的表不再同步（部署去掉了它）照样认，接着扫时跳到下一张 */
const fits = (key: Context['key'], scan: Scan) => !key(scan.table) || keyed(key, scan.table, scan.after);

/**
 * 带回的 cursor 认不认得出：解析得了、扫着的表与重下的范围合这张表的主键、各版都在当前历史上；认不出是 undefined。
 * 各消费者另有的条件由调用方查
 */
export function recognize(text: string, { onHistory, key }: Context): Position | undefined {
  const position = decodePosition(text);
  if (!position) return undefined;
  const { round, tail, seen, scan, ranges = [] } = position;
  const known = [seen, round.to, tail.at, round.from].every((at) => !at || onHistory(at));
  const keys =
    (!scan || fits(key, scan)) && ranges.every(({ table, after, until }) => keyed(key, table, after) && keyed(key, table, until));
  return known && keys ? position : undefined;
}

/** 设备要求重下的表，按表名、每张一项：起止缺主键的列、云端不同步的表当作整张表（多下一些，不漏） */
export function rangesOf(requested: PullRange[], key: Context['key']): Range[] {
  const ranges = new Map(
    requested.map(({ table, after, until }) => [
      table,
      keyed(key, table, after) && keyed(key, table, until) ? { table, ...(after && { after }), ...(until && { until }) } : { table },
    ]),
  );
  return [...ranges.keys()].sort().map((table) => ranges.get(table) as Range);
}
