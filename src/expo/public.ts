// Re-exports the common public surface shared across native mobile and web entry points so type checks verify both identically.

export type { Schema } from '../tables/table-definitions.ts';
export { ValidationError } from '../tables/validation.ts';
export { AccountMismatchError, PendingWritesError } from './errors.ts';
export type { SyncStatus } from './status.ts';
export type { Database, Syncline } from './syncline.ts';
