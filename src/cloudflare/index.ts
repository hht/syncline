// 云端的入口：私有空间、共用空间与它的广播分片、入口 Worker 里的转发、时间点恢复。
// 也是组装根：核心不提可插拔功能的名字，接入方继承的 SynclineSpace 在这里接上在线校验和与导出

import { spaceChecksum } from '../features/checksum/cloud/checksums.ts';
import { type ExportOptions, Exports } from '../features/exports/cloud/exports.ts';
import type { Schema } from '../tables/table-definitions.ts';
import { SpaceObject, type SpaceOptions } from './durable-object.ts';

export type { Bucket, BucketRules } from '../cloud/buckets.ts';
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

/** 接入方继承的私有空间的 Durable Object：SpaceObject 接上在线校验和与导出；options 另收导出的 ExportOptions */
export class SynclineSpace<Env = unknown> extends SpaceObject<Env> {
  constructor(ctx: DurableObjectState, env: Env, schema: Schema, options: SpaceOptions & ExportOptions = {}) {
    super(ctx, env, schema, options, { checksum: spaceChecksum, chores: (context) => new Exports(context, options) });
  }
}
