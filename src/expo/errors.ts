import { type Incompatibility, SchemaMismatch } from '../tables/declaration.ts';
import { type Issue, ValidationError } from '../tables/validation.ts';
import type { SyncStatus } from './status.ts';

/**
 * Bridges errors across the Worker-page boundary and from the Rust core back to JavaScript.
 *
 * Structured cloning in `postMessage` preserves only standard error names and messages (call stacks differ across browsers). The Rust
 * core reports errors that integrators inspect with `instanceof` (`ValidationError` with table/paths, `AccountMismatchError`, `PendingWritesError`)
 * and a schema mismatch in the serialized shape, and the page reconstructs them identical to native mobile, as it does sync status errors
 * (`downloadError`, `uploadError`) via `deserializeStatus`. Its other errors and those the Worker raises retain only their message. The two
 * device-only error classes (`AccountMismatchError`, `PendingWritesError`) are defined here.
 * What this module must not know: Where errors originate or how the page handles them.
 * @see https://html.spec.whatwg.org/multipage/structured-data.html#serializable-objects
 */

/**
 * Thrown when the cloud space does not match the space recorded when this database first synced.
 *
 * Occurs when switching accounts on the device while the local database belongs to the previous user (for example, another web tab
 * signed in with a different token). Sync stops without pushing pending writes into the other space. The app should reopen with the
 * current account (`userID`) or prompt the user to sign in again.
 */
export class AccountMismatchError extends Error {
  readonly stored: string;
  readonly cloud: string;

  constructor(stored: string, cloud: string) {
    super(`Account mismatch: local database belongs to ${stored}, but cloud is ${cloud}; sync stopped, reopen with current account`);
    this.name = 'AccountMismatchError';
    this.stored = stored;
    this.cloud = cloud;
  }
}

/**
 * Thrown when opening a database for a different user while un-uploaded pending writes remain from the previous user.
 *
 * Prevents clearing or opening the database so pending writes are not lost. The app should prompt the user to sign back in as `userID` to
 * finish syncing, or explicitly pass `discardPending` when opening.
 */
export class PendingWritesError extends Error {
  /** ID of the previous user. */
  readonly userID: string;
  /** Number of pending writes waiting to upload. */
  readonly count: number;

  constructor(userID: string, count: number) {
    super(`Previous user (${userID}) still has ${count} pending writes waiting to upload`);
    this.name = 'PendingWritesError';
    this.userID = userID;
    this.count = count;
  }
}

export type SerializedError = {
  message: string;
  stack?: string;
  validation?: { table: string; issues: Issue[] };
  account?: { stored: string; cloud: string };
  pending?: { owner: string; count: number };
  schema?: Incompatibility;
};

/** Serializes an error the Worker itself raised; the Worker never constructs the classes above, which only the Rust core reports. */
export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) return { message: String(error) };
  return error.stack === undefined ? { message: error.message } : { message: error.message, stack: error.stack };
}

/** Reconstructs an Error instance in the page, retaining the Worker call stack so reports locate the failure site. */
export function deserializeError(serialized: SerializedError) {
  const error = restored(serialized);
  if (serialized.stack !== undefined) error.stack = serialized.stack;
  return error;
}

function restored({ message, validation, account, pending, schema }: SerializedError): Error {
  if (validation) return new ValidationError(validation.table, validation.issues);
  if (account) return new AccountMismatchError(account.stored, account.cloud);
  if (pending) return new PendingWritesError(pending.owner, pending.count);
  if (schema) return new SchemaMismatch(schema);
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
