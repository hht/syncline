// Resource and payload limits shared across device and cloud, bounding per-request and per-space work.

/**
 * Maximum SQL storage value size in a Durable Object.
 * Values stored by Syncline (a row, parameter, or commit log entry) derive from this ceiling.
 * Shared between device and cloud so local writes reject oversized values before upload rather than being held on the server.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */

/** Maximum byte length of a single string, BLOB, or table row. */
export const valueBytes = 2_000_000;

/** Maximum chunk size in UTF-16 code units when slicing values, leaving headroom below valueBytes. */
export const valueChars = valueBytes / 4;

/**
 * Maximum UTF-8 byte length of a synced table primary key serialized as JSON.
 * Included in pull pagination cursors and in shared space pull URLs (Cloudflare URLs are capped at 16 KB, and non-ASCII bytes triple under percent-encoding).
 * Enforced on local writes and re-checked on the cloud.
 * @see https://developers.cloudflare.com/workers/platform/limits/
 * @see https://firebase.google.com/docs/firestore/quotas
 * @see https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html
 */
export const keyBytes = 512;

/**
 * Maximum UTF-8 byte length of a device subscription (canonical sorted bucket array) in a shared space.
 * Each pull echoes the landed subscription base64-encoded in the URL together with the cursor.
 * Bounds bucket merge work on connections while fitting comfortably within Cloudflare URL size limits.
 * @see https://developers.cloudflare.com/workers/platform/limits/
 * @see https://github.com/powersync-ja/powersync-service/blob/12fa59d700ded33dc33770855bde90ffb60ebc8f/packages/service-core/src/util/config/defaults.ts#L4
 */
export const subscriptionBytes = 8192;

/**
 * Maximum number of rows modified in a single mutation, including cascade deletes.
 * Applies to pushed client writes, server writes, and local writes.
 * Bounded to prevent CPU and memory exhaustion in Cloudflare Durable Object transactions.
 * Oversized pushes are held, oversized server writes throw, and local writes roll back.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 * @see probes/cloudflare/push-size.ts
 */
export const writeRows = 100_000;

/**
 * Maximum number of rows modified in a single server write in a shared space, including cascade deletes.
 * Each row updates bucket indexes and row counts, which consumes significantly more CPU than in a private space.
 * Bounded to keep transactions within CPU execution limits.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 * @see probes/cloudflare/shared-write.ts
 */
export const sharedWriteRows = 10_000;

/**
 * Maximum total UTF-8 byte length of JSON-serialized primary keys touched by a single mutation, including cascade deletes.
 * Bounded to stay within Durable Object memory limits when accumulating touched keys for the commit log and bucket index updates.
 * Oversized writes are held or rejected.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */
export const writeKeyBytes = 16_000_000;

/**
 * Maximum UTF-8 byte length of JSON-serialized changes in a single mutation.
 * Enforced on local writes so pushed mutations fit inside WebSocket messages and execute within Durable Object CPU limits.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 * @see probes/cloudflare/push-size.ts
 */
export const writeBytes = 8 * 2 ** 20;

/**
 * Maximum UTF-8 byte length of a raw push payload accepted by the cloud before JSON parsing.
 * Rejects oversized payloads upfront to prevent isolate resets from exceeding Durable Object CPU limits during JSON parsing.
 * @see probes/cloudflare/push-size.ts
 */
export const pushBytes = writeBytes + 2 ** 20;

/**
 * Maximum UTF-8 byte length of a private space HTTP pull request body.
 * Requests exceeding this limit return HTTP 413 to prevent isolate out-of-memory errors before parsing.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */
export const pullBytes = 4 * valueBytes;

/**
 * Maximum number of SQLite rows scanned in a single private space pull chunk or catch-up response, including skipped commits.
 * Bounds per-request read work and billing regardless of space history or table size.
 */
export const readRows = 20_000;

/**
 * Commit log size threshold in bytes for triggering background truncation.
 * Log truncation trims the oldest commits to three quarters of this threshold while preserving the head commit.
 * @see https://developers.cloudflare.com/durable-objects/platform/pricing/
 */
export const commitFloor = 64 * 2 ** 20;

export const truncateRows = 10_000;

export const truncateBytes = 64 * 2 ** 20;

/**
 * Approximate body byte budget read into memory in a single database batch during pulls, notifications, or checksums.
 * Bounded well below the Durable Object memory ceiling.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */
export const readBytes = 1_000_000;

/** Maximum number of rows or commits fetched from SQLite per query batch. */
export const batchRows = 100;
