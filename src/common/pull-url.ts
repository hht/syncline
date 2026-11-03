import { bounds, invalid, isCount, isNames, isObject, parseCookie, cookie as parseCookieValue } from './parse.ts';
import { type Cookie, formatCookie, type PullRange } from './protocol.ts';
import { protocolVersion, versionParam } from './version.ts';

/**
 * HTTP 拉取与 WebSocket 连接的请求怎么带：共用空间的拉取只用 GET、请求全在查询串里（照 ElectricSQL：只有 GET 能进缓存，共用空间的响应要经缓存发出）；
 * 私有空间的拉取不进缓存，用 POST、请求放在 JSON 正文里，网址只带协议版本（列出的客户端随启动次数涨，放网址会超过 16 KB）；
 * WebSocket 的网址只带协议版本与游标（私有空间连上时按游标补齐确认，不列客户端）。
 * 不该知道的：拉取怎么切块、响应长什么样。
 * @see https://doc.replicache.dev/reference/server-pull
 * @see https://developers.cloudflare.com/workers/platform/limits/（URL size）
 */

/**
 * 拉取的请求：本机游标（还没同步过是 null），分块拉取中途时带暂存的最后一块的 next。
 * 共用空间另带 landed（落地时的订阅，末块给的、原样带回）；发现末块比暂存的块早时另带 atLeast（暂存各块最大的 seen）：新的缓存键，
 * 它的响应只能在云端到了这一版之后算出；分片说的这一代与本机的不同时另带 incarnation（分片说的那一代）：同样是新的缓存键，云端不在这一代时现算、不进缓存。
 * 私有空间另带：refetch：从头整份给、游标与待上传不动（App 回滚期间不声明的表再声明时）；
 * checksum：末块带从这里起一段的校验和（上一段给的 next，从头是空串；设备追平、没有待上传、该对了时要，云端当场算这一段），
 * 这一段至多 checksumRows 行（设备对的途中库变了就减半；没给是云端的上限）；
 * ranges：按范围重下的几张表（校验和对不上的那一段，每张表至多一项），只在不带 cursor 的增量拉取里算数；
 * clients：带上待上传的与当前的客户端，末块只带它们处理到第几条（每次启动一个客户端，全带会随启动次数一直涨）；
 * earliest：列出的客户端各自最早的待上传序号（没有待上传的当前客户端是它下一条写的序号），末块只带从它起扣下的写（设备只用得到这次确认的写里扣下的）
 */
export type PullRequest = {
  cookie: Cookie | null;
  cursor?: string;
  landed?: string;
  atLeast?: number;
  incarnation?: number;
  refetch?: true;
  checksum?: string;
  checksumRows?: number;
  ranges?: PullRange[];
  clients?: string[];
  earliest?: Record<string, number>;
};

/** 放进网址的请求：共用空间的 HTTP 拉取，与 WebSocket 的连接（只带游标） */
type QueryRequest = Pick<PullRequest, 'cookie' | 'cursor' | 'landed' | 'atLeast' | 'incarnation'>;

/** 游标在网址里的写法：参数 cookie=版本.随机数；还没同步过不带 */
const cookieParam = 'cookie';
/** 分块拉取中途的 cursor、共用空间落地时的订阅、下限与这一代在网址里的参数名 */
const cursorParam = 'cursor';
const landedParam = 'landed';
const atLeastParam = 'atLeast';
const incarnationParam = 'incarnation';

/** 拉取或连接的网址：url 带上协议版本与放进网址的请求（不给就只带版本：私有空间的 POST） */
export function pullURL(url: string, { cookie, cursor, landed, atLeast, incarnation }: QueryRequest = { cookie: null }) {
  const target = new URL(url);
  target.searchParams.set(versionParam, String(protocolVersion));
  if (cookie) target.searchParams.set(cookieParam, formatCookie(cookie));
  if (cursor !== undefined) target.searchParams.set(cursorParam, cursor);
  if (landed !== undefined) target.searchParams.set(landedParam, landed);
  if (atLeast !== undefined) target.searchParams.set(atLeastParam, String(atLeast));
  if (incarnation !== undefined) target.searchParams.set(incarnationParam, String(incarnation));
  return target.href;
}

/** 网址里一个不小于 0 的整数参数；没有是 undefined */
function countOf(url: URL, name: string, what: string) {
  const text = url.searchParams.get(name);
  if (text !== null && !/^\d+$/.test(text)) invalid(what, text);
  return text === null ? undefined : Number(text);
}

/** 网址的查询串只认这几个参数：别的都是设备不会发的，回错误（共用空间的缓存键由网址决定，多一个参数就多一份缓存） */
export function parsePullRequest(url: URL): QueryRequest {
  const unknown = [...url.searchParams.keys()].find(
    (key) => ![versionParam, cookieParam, cursorParam, landedParam, atLeastParam, incarnationParam].includes(key),
  );
  if (unknown !== undefined) invalid('拉取的参数', unknown);
  const cursor = url.searchParams.get(cursorParam);
  const landed = url.searchParams.get(landedParam);
  const atLeast = countOf(url, atLeastParam, '拉取的下限');
  const incarnation = countOf(url, incarnationParam, '拉取的这一代');
  return {
    cookie: parseCookie(url.searchParams.get(cookieParam)),
    ...(cursor === null ? {} : { cursor }),
    ...(landed === null ? {} : { landed }),
    ...(atLeast === undefined ? {} : { atLeast }),
    ...(incarnation === undefined ? {} : { incarnation }),
  };
}

/** 私有空间 HTTP 拉取的正文 */
export const pullBody = ({ cookie, cursor, refetch, checksum, checksumRows, ranges, clients, earliest }: PullRequest) =>
  JSON.stringify({ cookie, cursor, refetch, checksum, checksumRows, ranges, clients, earliest });

/** 正文里按范围重下的表：每张表至多一项 */
function rangesOf(value: unknown): PullRange[] {
  if (!Array.isArray(value)) invalid('按范围重下', value);
  const tables = new Set<string>();
  return value.map((item: unknown) => {
    if (!isObject(item) || typeof item.table !== 'string' || item.table === '' || tables.has(item.table)) invalid('按范围重下', item);
    tables.add(item.table);
    return { table: item.table, ...bounds(item) };
  });
}

/** 正文里各项认不认得出：没列的项是设备不会发的 */
const bodyChecks: Record<string, (value: unknown) => boolean> = {
  cursor: (value) => typeof value === 'string',
  refetch: (value) => value === true,
  checksum: (value) => typeof value === 'string',
  checksumRows: (value) => isCount(value) && value > 0,
  clients: isNames,
  // 各客户端最早的待上传序号：序号从 1 起
  earliest: (value) => isObject(value) && Object.values(value).every((id) => isCount(id) && id > 0),
};

/** 私有空间 HTTP 拉取的正文只认这几项：别的、类型不对的都是设备不会发的，回错误 */
export function parsePullBody(text: string): PullRequest {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) invalid('拉取的正文', value);
  const { cookie, ranges, ...rest } = value;
  // 只认 bodyChecks 自己的项：constructor、toString 这类名字查到的是 Object.prototype 上的函数
  for (const [key, item] of Object.entries(rest))
    if (!Object.hasOwn(bodyChecks, key) || !bodyChecks[key]?.(item)) invalid(`拉取的 ${key} `, item);
  return {
    ...(rest as Omit<PullRequest, 'cookie' | 'ranges'>),
    cookie: cookie === null ? null : parseCookieValue(cookie),
    ...(ranges === undefined ? {} : { ranges: rangesOf(ranges) }),
  };
}
