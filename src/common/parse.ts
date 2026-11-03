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
 * Boundary parser for wire protocol messages between device and cloud.
 * Device parses pull results, notifications, and hints; cloud parses pushed mutations.
 * Throws on malformed inputs without guessing.
 */

type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function invalid(what: string, value: unknown): never {
  throw new Error(`Malformed ${what}: ${JSON.stringify(value)?.slice(0, 200)}`);
}

export function cookie(value: unknown): Cookie {
  if (!isObject(value) || !isCount(value.version) || !isCount(value.nonce)) invalid('Cookie', value);
  return { version: value.version, nonce: value.nonce };
}

const isValue = (value: unknown) => value === null || typeof value === 'string' || Number.isFinite(value);
export const isValues = (value: unknown): value is Record<string, Value> => isObject(value) && Object.values(value).every(isValue);

// Downstream row change: primary key and row values must be SQLite primitives (null, string, finite number) for direct binding.
function op(value: unknown): Op {
  if (!isObject(value)) invalid('Op', value);
  if (value.op === 'clear') return { op: 'clear' };
  if (typeof value.table !== 'string') invalid('Op', value);
  if (value.op === 'put' && isValues(value.key) && isValues(value.row))
    return { op: 'put', table: value.table, key: value.key, row: value.row };
  if (value.op === 'del' && isValues(value.key)) return { op: 'del', table: value.table, key: value.key };
  if (value.op === 'drop' && value.range !== undefined && value.columns === undefined)
    return { op: 'drop', table: value.table, range: keyRange(value.range) };
  if (value.op === 'drop' && value.range === undefined && (value.columns === undefined || isNames(value.columns)))
    return { op: 'drop', table: value.table, ...(value.columns && { columns: value.columns }) };
  invalid('Op', value);
}

export const isProgress = (value: unknown): value is Progress => isObject(value) && isCount(value.downloaded) && isCount(value.total);

function progress(value: unknown): Progress {
  if (!isProgress(value)) invalid('Progress', value);
  return { downloaded: value.downloaded, total: value.total };
}

const isText = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string';
export const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === 'string');

/** Parses an HTTP pull response text into a Poke, Chunk, or Reset. */
export const parsePoke = (text: string) => pokeOf(JSON.parse(text));

/**
 * Parses a WebSocket message from the cloud into a Poke or Hint.
 * Hints instruct the device to pull over HTTP when the patch exceeds WebSocket limits
 * or when a broadcast shard cannot resume directly from the connection's last seen version.
 * @see https://doc.replicache.dev/byob/poke
 */
export function parseMessage(text: string): Poke | Hint {
  const value: unknown = JSON.parse(text);
  if (isObject(value) && 'hint' in value) return { hint: cookie(value.hint), ...adviceOf(value), ...originOf(value) };
  const message = pokeOf(value);
  if (!('cookie' in message)) invalid('Poke', value);
  return message;
}

function pokeOf(value: unknown): Poke | Chunk | Reset {
  if (!isObject(value)) invalid('Poke', value);
  const base = value.base === null ? null : cookie(value.base);
  if (value.reset === true) return { base, reset: true, ...originOf(value) };
  const { cursor, next, patch, seen } = value;
  if (!isText(cursor) || !isText(next) || !Array.isArray(patch) || (seen !== undefined && !isCount(seen))) invalid('Poke', value);
  const ops = patch.map(op);
  // Clear op is only allowed as the first entry of the initial chunk.
  if (ops.slice(1).some(({ op: kind }) => kind === 'clear')) invalid('Poke', value);
  const common = {
    base,
    ...(cursor === undefined ? {} : { cursor }),
    patch: ops,
    ...(seen === undefined ? {} : { seen }),
    ...originOf(value),
  };
  // Only the final chunk carries a cookie.
  return value.cookie === undefined ? parseChunk(value, common) : parseLast(value, common);
}

type Common = Omit<Chunk, 'next' | 'progress'>;

function parseChunk(value: Json, common: Common): Chunk {
  if (typeof value.next !== 'string') invalid('Poke', value);
  return { ...common, next: value.next, ...(value.progress === undefined ? {} : { progress: progress(value.progress) }) };
}

function parseLast(value: Json, common: Common): Poke {
  const { lmids, next, landed } = value;
  if (!isObject(lmids) || !Object.values(lmids).every(isCount) || !isText(landed)) invalid('Poke', value);
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
  if (!isText(space) || !isText(sub) || (incarnation !== undefined && !isCount(incarnation)))
    invalid('Origin', { space, sub, incarnation });
  return {
    ...(space === undefined ? {} : { space }),
    ...(sub === undefined ? {} : { sub }),
    ...(incarnation === undefined ? {} : { incarnation }),
  };
}

function adviceOf({ spread, expiresIn }: Json): Advice {
  if ((spread !== undefined && !isCount(spread)) || (expiresIn !== undefined && typeof expiresIn !== 'number'))
    invalid('Advice', { spread, expiresIn });
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
    invalid('Checksum', value);
  const { tables } = value;
  const parts = value.parts.map((part: unknown): ChecksumPart => {
    if (!isObject(part) || typeof part.table !== 'string') invalid('Checksum part', part);
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

// Primary key range: requires at least one column and SQLite primitive bounds.
function keyRange(value: unknown): KeyRange {
  if (!isObject(value) || !isNames(value.key) || value.key.length === 0) invalid('Key range', value);
  return { key: value.key, ...bounds(value) };
}

// Key range bounds: omitted after or until indicates unbounded start or end.
export function bounds({ after, until }: Json): Omit<KeyRange, 'key'> {
  if ((after !== undefined && !isValues(after)) || (until !== undefined && !isValues(until))) invalid('Key range', { after, until });
  return { ...(after === undefined ? {} : { after }), ...(until === undefined ? {} : { until }) };
}

function heldOf(value: unknown) {
  if (!Array.isArray(value)) invalid('Held write', value);
  return value.map((entry: unknown) => {
    if (!isObject(entry) || typeof entry.client !== 'string' || !isCount(entry.id) || typeof entry.reason !== 'string')
      invalid('Held write', entry);
    return { client: entry.client, id: entry.id, reason: entry.reason };
  });
}

function change(value: unknown): Change {
  if (!isObject(value) || typeof value.table !== 'string') invalid('Row change', value);
  if ((value.op === 'put' || value.op === 'patch') && isValues(value.row)) return { op: value.op, table: value.table, row: value.row };
  if (value.op === 'del' && isValues(value.key)) return { op: 'del', table: value.table, key: value.key };
  invalid('Row change', value);
}

/** Parses mutation changes, requiring a non-empty array of recognized row modifications. */
export function parseChanges(value: unknown): Change[] {
  if (!Array.isArray(value) || value.length === 0) invalid('Mutation changes', value);
  return value.map(change);
}

/**
 * Pushed client write received by the cloud.
 * Mutations with unrecognized changes carry original changes and a malformed reason
 * so the cloud can hold the write and advance the sequence number without rejecting the batch.
 */
export type Pushed = Mutation | (Omit<Mutation, 'changes'> & { changes: unknown; malformed: string });

/**
 * Parses a push batch of client mutations ordered by client sequence.
 * Rejects the batch if array structure or mutation identities are invalid;
 * mutations with malformed changes are preserved as held writes.
 */
export function parseMutations(text: string): Pushed[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length > pushMutations) invalid('Push', value);
  return value.map((mutation: unknown): Pushed => {
    if (!isObject(mutation) || typeof mutation.client !== 'string' || !isCount(mutation.id)) invalid('Mutation', mutation);
    if (mutation.first !== undefined && mutation.first !== true) invalid('Mutation', mutation);
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
  if (!match) invalid('Cookie', text);
  return cookie({ version: Number(match[1]), nonce: Number(match[2]) });
}
