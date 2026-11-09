// Cloud entry point: private spaces, shared spaces and their broadcast shards, Worker forwarding, and point-in-time recovery.
// Assembly root: wires pluggable online checksums and exports into {@link SynclineSpace}.

import { spaceChecksum } from '../features/checksum/cloud/checksums.ts';
import { type ExportOptions, Exports } from '../features/exports/cloud/exports.ts';
import type { Schema } from '../tables/table-definitions.ts';
import { SpaceObject, type SpaceOptions } from './durable-object.ts';

export type { Bucket, BucketRules } from '../cloud/buckets.ts';
export type { SynclineEvent } from '../cloud/events.ts';
export type { Transaction } from '../cloud/transaction.ts';
export type { Change } from '../common/protocol.ts';
export type { Exporter } from '../features/exports/cloud/exports.ts';
export { ValidationError } from '../tables/validation.ts';
export { restoreSpace } from './durable-object.ts';
export { forward, type Identity } from './forward.ts';
export {
  forwardShared,
  type SharedDefinition,
  type SharedIdentity,
  SynclineBroadcast,
  SynclineSharedEntry,
  SynclineSharedSpace,
} from './shared.ts';

/** Base Durable Object for private spaces, extending {@link SpaceObject} with online checksum verification and exports. */
export class SynclineSpace<Env = unknown> extends SpaceObject<Env> {
  constructor(ctx: DurableObjectState, env: Env, schema: Schema, options: SpaceOptions & ExportOptions = {}) {
    super(ctx, env, schema, options, { checksum: spaceChecksum, chores: (context) => new Exports(context, options) });
  }
}
