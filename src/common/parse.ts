import { clientChars } from './limits.ts';
import { type Change, type Cookie, type KeyRange, type Mutation, type Progress, pushMutations, type Value } from './protocol.ts';

/**
 * Boundary parsing of what the cloud receives from devices: pushed mutations, plus the value checks pull requests share
 * (the device core parses what the cloud sends).
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

// Text must be well-formed: SQLite stores a lone surrogate as-is and reads it back replaced, so a key holding one is never found again.
const isValue = (value: unknown) => value === null || (typeof value === 'string' ? value.isWellFormed() : Number.isFinite(value));
export const isValues = (value: unknown): value is Record<string, Value> => isObject(value) && Object.values(value).every(isValue);

export const isProgress = (value: unknown): value is Progress => isObject(value) && isCount(value.downloaded) && isCount(value.total);

export const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === 'string');

// Key range bounds: omitted after or until indicates unbounded start or end.
export function bounds({ after, until }: Json): Omit<KeyRange, 'key'> {
  if ((after !== undefined && !isValues(after)) || (until !== undefined && !isValues(until))) invalid('Key range', { after, until });
  return { ...(after === undefined ? {} : { after }), ...(until === undefined ? {} : { until }) };
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

/** Client ID: well-formed (live notices carry it to Rust, which rejects lone surrogates) and at most clientChars long. */
const isClient = (value: unknown): value is string => typeof value === 'string' && value.length <= clientChars && value.isWellFormed();

/**
 * Parses a push batch of client mutations ordered by client sequence.
 * Rejects the batch if array structure or mutation identities are invalid;
 * mutations with malformed changes are preserved as held writes.
 */
export function parseMutations(text: string): Pushed[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length > pushMutations) invalid('Push', value);
  return value.map((mutation: unknown): Pushed => {
    if (!isObject(mutation) || !isClient(mutation.client) || !isCount(mutation.id)) invalid('Mutation', mutation);
    if (mutation.first !== undefined && mutation.first !== true) invalid('Mutation', mutation);
    const identity = { client: mutation.client, id: mutation.id, ...(mutation.first === true && { first: true as const }) };
    try {
      return { ...identity, changes: parseChanges(mutation.changes) };
    } catch (error) {
      // An Error: parseChanges throws nothing else
      return { ...identity, changes: mutation.changes ?? null, malformed: (error as Error).message };
    }
  });
}

export function parseCookie(text: string | null): Cookie | null {
  if (text === null) return null;
  const match = /^(\d+)\.(\d+)$/.exec(text);
  if (!match) invalid('Cookie', text);
  return cookie({ version: Number(match[1]), nonce: Number(match[2]) });
}
