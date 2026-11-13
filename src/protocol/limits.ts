// Limits device and cloud must both hold to on keys, table names, client IDs, subscriptions, and writes: whichever side produces such a
// value keeps within them, and the cloud checks what devices send. What it must not know: how either side does its own work.

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
 * Maximum length of a table name (ASCII, so characters are bytes), as in MySQL.
 * A shared space pull URL carries the table its cursor scans beside the largest key, bucket, and landed subscription, which leave about
 * 2 KB of Cloudflare's 16 KB URL limit; table names are otherwise unbounded.
 * @see https://dev.mysql.com/doc/refman/8.4/en/identifier-length.html
 * @see https://developers.cloudflare.com/workers/platform/limits/
 */
export const tableNameChars = 64;

/**
 * Maximum length of a client ID in UTF-16 code units: devices generate UUIDs (36 characters).
 * Bounds lmid rows and live notices, which carry client IDs, against modified clients.
 */
export const clientChars = 64;

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
