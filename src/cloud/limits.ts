import { writeBytes } from '../protocol/limits.ts';
import { valueBytes } from '../sqlite/storage.ts';

// Bounds on what the cloud takes in and does per request, write, and upkeep step, keeping within Durable Object CPU, memory, and name
// limits and bounding storage and billed reads.
// What it must not know: devices, which never see these numbers.

/**
 * Maximum number of rows modified in a single server write in a shared space, including cascade deletes.
 * Each row updates bucket indexes and row counts, which consumes significantly more CPU than in a private space.
 * Bounded to keep transactions within CPU execution limits.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 * @see probes/cloudflare/shared-write.ts
 */
export const sharedWriteRows = 10_000;

/**
 * Maximum UTF-8 byte length of a raw push payload accepted by the cloud before JSON parsing.
 * Rejects oversized payloads upfront to prevent isolate resets from exceeding Durable Object CPU limits during JSON parsing.
 * @see probes/cloudflare/push-size.ts
 */
export const pushBytes = writeBytes + 2 ** 20;

/**
 * Maximum number of SQLite rows scanned in a single private space pull chunk or catch-up response, including skipped commits.
 * Bounds per-request read work and billing regardless of space history or table size.
 */
export const readRows = 20_000;

/**
 * Approximate body byte budget read into memory in a single database batch during pulls, notifications, or checksums.
 * Bounded well below the Durable Object memory ceiling.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */
export const readBytes = 1_000_000;

/** Maximum number of rows or commits fetched from SQLite per query batch. */
export const batchRows = 100;

/**
 * Commit log size threshold in bytes for triggering background truncation.
 * Log truncation trims the oldest commits to three quarters of this threshold while preserving the head commit.
 * @see https://developers.cloudflare.com/durable-objects/platform/pricing/
 */
export const commitFloor = 64 * 2 ** 20;

/** Maximum commits one commit log truncation step deletes; the next step continues from the new floor. */
export const truncateRows = 10_000;

/** Maximum commit log key bytes one truncation step deletes; the next step continues from the new floor. */
export const truncateBytes = 64 * 2 ** 20;

/**
 * Maximum UTF-8 byte length of a private space HTTP pull request body.
 * Requests exceeding this limit return HTTP 413 to prevent isolate out-of-memory errors before parsing.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */
export const pullBytes = 4 * valueBytes;

/**
 * Maximum byte length of a Durable Object name that reaches the object: longer names leave ctx.id.name undefined, so a shared space's
 * name with its longest shard suffix (#index) must fit.
 * @see https://developers.cloudflare.com/durable-objects/api/id/#name
 */
export const nameBytes = 1024;
