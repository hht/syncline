import {
  type Advice,
  type Change,
  type Checksum,
  type ChecksumPart,
  type Chunk,
  type Cookie,
  type Hint,
  type KeyRange,
  type Mutation,
  type Op,
  type Origin,
  type Poke,
  type Progress,
  pushMutations,
  type Reset,
  type Value,
} from './protocol.ts';

/**
 * 线上的消息在两端的边界解析成精确类型：设备解析云端的拉取结果、通知与提示，云端解析推上来的写；对不上就抛错，不猜。
 * 不该知道的：消息从哪来、解析出的怎么用。
 */

type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function invalid(what: string, value: unknown): never {
  throw new Error(`${what}格式不对：${JSON.stringify(value)?.slice(0, 200)}`);
}

export function cookie(value: unknown): Cookie {
  if (!isObject(value) || !isCount(value.version) || !isCount(value.nonce)) invalid('游标', value);
  return { version: value.version, nonce: value.nonce };
}

const isValue = (value: unknown) => value === null || typeof value === 'string' || Number.isFinite(value);
export const isValues = (value: unknown): value is Record<string, Value> => isObject(value) && Object.values(value).every(isValue);

/** 下发的一条改动：主键与行的值只有 SQLite 存得下的（null、字符串、有限的数），设备直接绑进 SQL */
function op(value: unknown): Op {
  if (!isObject(value)) invalid('改动', value);
  if (value.op === 'clear') return { op: 'clear' };
  if (typeof value.table !== 'string') invalid('改动', value);
  if (value.op === 'put' && isValues(value.key) && isValues(value.row))
    return { op: 'put', table: value.table, key: value.key, row: value.row };
  if (value.op === 'del' && isValues(value.key)) return { op: 'del', table: value.table, key: value.key };
  if (value.op === 'drop' && value.range !== undefined && value.columns === undefined)
    return { op: 'drop', table: value.table, range: keyRange(value.range) };
  if (value.op === 'drop' && value.range === undefined && (value.columns === undefined || isNames(value.columns)))
    return { op: 'drop', table: value.table, ...(value.columns && { columns: value.columns }) };
  invalid('改动', value);
}

export const isProgress = (value: unknown): value is Progress => isObject(value) && isCount(value.downloaded) && isCount(value.total);

function progress(value: unknown): Progress {
  if (!isProgress(value)) invalid('进度', value);
  return { downloaded: value.downloaded, total: value.total };
}

const isText = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string';
export const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === 'string');

/** HTTP 拉取的结果 */
export const parsePoke = (text: string) => pokeOf(JSON.parse(text));

/**
 * WebSocket 上云端发来的消息：通知（补齐也是），或共用空间分片的提示。提示只带空间到了哪一版、不带改动
 * （照 Replicache 的 poke：只叫设备去拉）：改动太多、通知装不下，或设备连上时接不上分片记下的通知，设备落后就 HTTP 拉（经缓存）、不断开
 * @see https://doc.replicache.dev/byob/poke
 */
export function parseMessage(text: string): Poke | Hint {
  const value: unknown = JSON.parse(text);
  if (isObject(value) && 'hint' in value) return { hint: cookie(value.hint), ...adviceOf(value), ...originOf(value) };
  const message = pokeOf(value);
  if (!('cookie' in message)) invalid('通知', value);
  return message;
}

function pokeOf(value: unknown): Poke | Chunk | Reset {
  if (!isObject(value)) invalid('通知', value);
  const base = value.base === null ? null : cookie(value.base);
  if (value.reset === true) return { base, reset: true, ...originOf(value) };
  const { cursor, next, patch, seen } = value;
  if (!isText(cursor) || !isText(next) || !Array.isArray(patch) || (seen !== undefined && !isCount(seen))) invalid('通知', value);
  const ops = patch.map(op);
  // 清空只在整份的第一块开头：在中间的话前面的改动白下了，是云端的缺陷
  if (ops.slice(1).some(({ op: kind }) => kind === 'clear')) invalid('通知', value);
  const common = {
    base,
    ...(cursor === undefined ? {} : { cursor }),
    patch: ops,
    ...(seen === undefined ? {} : { seen }),
    ...originOf(value),
  };
  // 只有末块带游标
  return value.cookie === undefined ? parseChunk(value, common) : parseLast(value, common);
}

type Common = Omit<Chunk, 'next' | 'progress'>;

function parseChunk(value: Json, common: Common): Chunk {
  if (typeof value.next !== 'string') invalid('通知', value);
  return { ...common, next: value.next, ...(value.progress === undefined ? {} : { progress: progress(value.progress) }) };
}

function parseLast(value: Json, common: Common): Poke {
  const { lmids, next, landed } = value;
  if (!isObject(lmids) || !Object.values(lmids).every(isCount) || !isText(landed)) invalid('通知', value);
  return {
    ...common,
    cookie: cookie(value.cookie),
    lmids: lmids as Record<string, number>,
    ...(typeof next === 'string' ? { next } : {}),
    ...(landed === undefined ? {} : { landed }),
    ...(value.held === undefined ? {} : { held: heldOf(value.held) }),
    ...(value.checksum === undefined ? {} : { checksum: checksumOf(value.checksum) }),
    ...adviceOf(value),
  };
}

function originOf({ space, sub, incarnation }: Json): Origin {
  if (!isText(space) || !isText(sub) || (incarnation !== undefined && !isCount(incarnation))) invalid('来处', { space, sub, incarnation });
  return {
    ...(space === undefined ? {} : { space }),
    ...(sub === undefined ? {} : { sub }),
    ...(incarnation === undefined ? {} : { incarnation }),
  };
}

function adviceOf({ spread, expiresIn }: Json): Advice {
  if ((spread !== undefined && !isCount(spread)) || (expiresIn !== undefined && typeof expiresIn !== 'number'))
    invalid('建议', { spread, expiresIn });
  return { ...(spread === undefined ? {} : { spread }), ...(expiresIn === undefined ? {} : { expiresIn }) };
}

function checksumOf(value: unknown): Checksum {
  if (
    !isObject(value) ||
    !Array.isArray(value.parts) ||
    !isCount(value.sum) ||
    value.sum >= 2 ** 32 ||
    !isCount(value.rows) ||
    !isText(value.next) ||
    (value.tables !== undefined && !isNames(value.tables))
  )
    invalid('校验和', value);
  const { tables } = value;
  const parts = value.parts.map((part: unknown): ChecksumPart => {
    if (!isObject(part) || typeof part.table !== 'string') invalid('校验和的一部分', part);
    return { table: part.table, ...keyRange(part) };
  });
  return {
    parts,
    sum: value.sum,
    rows: value.rows,
    ...(value.next === undefined ? {} : { next: value.next }),
    ...(tables === undefined ? {} : { tables }),
  };
}

/** 主键的一段：主键至少一列，起止只有 SQLite 存得下的值 */
function keyRange(value: unknown): KeyRange {
  if (!isObject(value) || !isNames(value.key) || value.key.length === 0) invalid('主键的一段', value);
  return { key: value.key, ...bounds(value) };
}

/** 一段的起止：after、until 没给是从头、到尾 */
export function bounds({ after, until }: Json): Omit<KeyRange, 'key'> {
  if ((after !== undefined && !isValues(after)) || (until !== undefined && !isValues(until))) invalid('主键的一段', { after, until });
  return { ...(after === undefined ? {} : { after }), ...(until === undefined ? {} : { until }) };
}

function heldOf(value: unknown) {
  if (!Array.isArray(value)) invalid('扣下的写', value);
  return value.map((entry: unknown) => {
    if (!isObject(entry) || typeof entry.client !== 'string' || !isCount(entry.id) || typeof entry.reason !== 'string')
      invalid('扣下的写', entry);
    return { client: entry.client, id: entry.id, reason: entry.reason };
  });
}

function change(value: unknown): Change {
  if (!isObject(value) || typeof value.table !== 'string') invalid('行的改动', value);
  if ((value.op === 'put' || value.op === 'patch') && isValues(value.row)) return { op: value.op, table: value.table, row: value.row };
  if (value.op === 'del' && isValues(value.key)) return { op: 'del', table: value.table, key: value.key };
  invalid('行的改动', value);
}

/** 一条写的改动：至少一项（设备不推没改东西的写），每项是认得出的行改动；不合就抛错 */
export function parseChanges(value: unknown): Change[] {
  if (!Array.isArray(value) || value.length === 0) invalid('写的改动', value);
  return value.map(change);
}

/**
 * 云端收到的一条写：改动认不出的（设备的缺陷、版本不符）带着原样的改动与原因 malformed，云端扣下它、推进序号，
 * 不拒收整批：整批拒收的话设备原样重推、再被拒，这个客户端之后的写永远推不上去
 */
export type Pushed = Mutation | (Omit<Mutation, 'changes'> & { changes: unknown; malformed: string });

/**
 * 云端收到的推送：按本机顺序的一批写，条数在上限之内。整批不是一组、超过条数，或哪条写认不出是哪个客户端的第几条（没法扣下、推进序号）
 * 就抛错，整批拒收；认得出身份、改动认不出的那条照收（Pushed 的 malformed）
 */
export function parseMutations(text: string): Pushed[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length > pushMutations) invalid('推送', value);
  return value.map((mutation: unknown): Pushed => {
    if (!isObject(mutation) || typeof mutation.client !== 'string' || !isCount(mutation.id)) invalid('写', mutation);
    if (mutation.first !== undefined && mutation.first !== true) invalid('写', mutation);
    const identity = { client: mutation.client, id: mutation.id, ...(mutation.first === true && { first: true as const }) };
    try {
      return { ...identity, changes: parseChanges(mutation.changes) };
    } catch (error) {
      return { ...identity, changes: mutation.changes ?? null, malformed: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function parseCookie(text: string | null): Cookie | null {
  if (text === null) return null;
  const match = /^(\d+)\.(\d+)$/.exec(text);
  if (!match) invalid('游标', text);
  return cookie({ version: Number(match[1]), nonce: Number(match[2]) });
}
