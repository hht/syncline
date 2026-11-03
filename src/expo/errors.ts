import { Reject } from '../common/storage.ts';
import { VersionMismatch } from '../common/version.ts';
import { type Incompatibility, SchemaMismatch } from '../tables/declaration.ts';
import { type Issue, ValidationError } from '../tables/validation.ts';
import type { SyncStatus } from './status.ts';

/**
 * Bridges errors across the Worker-page boundary and from the Rust core back to JavaScript.
 *
 * Structured cloning in `postMessage` preserves only standard error names and messages (call stacks differ across browsers). Errors that
 * integrators inspect with `instanceof` (`ValidationError` with table/paths, `AccountMismatch`, `PendingWrites`, `VersionMismatch`,
 * `SchemaMismatch`, and `Reject`) are serialized and reconstructed in the page identical to native mobile. Other errors retain only their
 * message. Errors returned by the Rust core follow this same shape, as do sync status errors (`downloadError`, `uploadError`)
 * reconstructed via `deserializeStatus`. The two device-only error classes (`AccountMismatch`, `PendingWrites`) are defined here.
 * What this module must not know: Where errors originate or how the page handles them.
 * @see https://html.spec.whatwg.org/multipage/structured-data.html#serializable-objects
 */

/**
 * Thrown when the cloud space does not match the space recorded when this database first synced.
 *
 * Occurs when switching accounts on the device while the local database belongs to the previous user (for example, another web tab
 * signed in with a different token). Sync stops without pushing pending writes into the other space. The app should reopen with the
 * current account (owner) or prompt the user to sign in again.
 */
export class AccountMismatch extends Error {
  readonly stored: string;
  readonly cloud: string;

  constructor(stored: string, cloud: string) {
    super(`Account mismatch: local database belongs to ${stored}, but cloud is ${cloud}; sync stopped, reopen with current account`);
    this.name = 'AccountMismatch';
    this.stored = stored;
    this.cloud = cloud;
  }
}

/**
 * Thrown when opening a database for a different owner while un-uploaded pending writes remain from the previous owner.
 *
 * Prevents clearing or opening the database so pending writes are not lost. The app should prompt the user to sign back in as `owner` to
 * finish syncing, or explicitly pass `discardPending` when opening.
 */
export class PendingWrites extends Error {
  /** Previous owner. */
  readonly owner: string;
  /** Number of pending writes waiting to upload. */
  readonly count: number;

  constructor(owner: string, count: number) {
    super(`Previous user (${owner}) still has ${count} pending writes waiting to upload`);
    this.name = 'PendingWrites';
    this.owner = owner;
    this.count = count;
  }
}

export type SerializedError = {
  message: string;
  stack?: string;
  validation?: { table: string; issues: Issue[] };
  account?: { stored: string; cloud: string };
  pending?: { owner: string; count: number };
  version?: number;
  schema?: Incompatibility;
  reject?: Record<string, never>;
};

export function serializeError(error: unknown): SerializedError {
  if (error instanceof ValidationError) return { message: error.message, validation: { table: error.table, issues: error.issues } };
  if (error instanceof AccountMismatch) return { message: error.message, account: { stored: error.stored, cloud: error.cloud } };
  if (error instanceof PendingWrites) return { message: error.message, pending: { owner: error.owner, count: error.count } };
  if (error instanceof VersionMismatch) return { message: error.message, version: error.cloud };
  if (error instanceof SchemaMismatch) return { message: error.message, schema: { kind: error.kind, names: error.names } };
  if (error instanceof Reject) return { message: error.message, reject: {} };
  if (!(error instanceof Error)) return { message: String(error) };
  return error.stack === undefined ? { message: error.message } : { message: error.message, stack: error.stack };
}

/** Reconstructs an Error instance in the page, retaining the Worker call stack so reports locate the failure site. */
export function deserializeError(serialized: SerializedError) {
  const error = restored(serialized);
  if (serialized.stack !== undefined) error.stack = serialized.stack;
  return error;
}

function restored({ message, validation, account, pending, version, schema, reject }: SerializedError): Error {
  if (validation) return new ValidationError(validation.table, validation.issues);
  if (account) return new AccountMismatch(account.stored, account.cloud);
  if (pending) return new PendingWrites(pending.owner, pending.count);
  if (version !== undefined) return new VersionMismatch(version);
  if (schema) return new SchemaMismatch(schema);
  if (reject) return new Reject(message);
  return new Error(message);
}

/** Carries sync status across the Worker boundary with serialized download and upload errors. */
export type SerializedStatus = Omit<SyncStatus, 'downloadError' | 'uploadError'> & {
  downloadError: SerializedError | undefined;
  uploadError: SerializedError | undefined;
};

export const deserializeStatus = ({ downloadError, uploadError, ...status }: SerializedStatus): SyncStatus => ({
  ...status,
  downloadError: downloadError && deserializeError(downloadError),
  uploadError: uploadError && deserializeError(uploadError),
});
