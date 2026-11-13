/**
 * Protocol messages exchanged between device and space: pushes, pulls, and notifications.
 * Transport-agnostic message shapes independent of specific schema definitions.
 * @see https://doc.replicache.dev/reference/server-push
 * @see https://doc.replicache.dev/reference/server-pull
 */

/** Identifies the exact commit version of a space: version is the sequential version number, and nonce distinguishes forks across restores and rebuilds. */
export type Cookie = { version: number; nonce: number };

/** Checks whether two cookies represent the exact same commit version and nonce. */
export const sameCookie = (a: Cookie | null, b: Cookie | null) => a?.version === b?.version && a?.nonce === b?.nonce;

/** A commit cookie paired with its space incarnation nonce. */
export type Point = { cookie: Cookie; incarnation: number | undefined };

/** Checks whether point a is newer than point b (Newer in model/Shared.tla): b is absent, from a different incarnation, or has an older version in the same incarnation. */
export const newer = (a: Point, b: Point | undefined) => !b || a.incarnation !== b.incarnation || a.cookie.version > b.cookie.version;

/**
 * Client mutation recorded during a local write.
 * Mutation id increments from 1 per client. Changes record modified rows.
 * The `first` flag marks the earliest unconfirmed pending write for a client, enabling the cloud to advance lmid across restore jumps.
 */
export type Mutation = { client: string; id: number; changes: Change[]; first?: true };

/** Primitive SQLite column value: integer, real, text, or null. */
export type Value = number | string | null;

/**
 * Single row modification within a client mutation.
 * Put upserts a full row; patch updates specified columns if the row exists; del deletes by primary key.
 * @see https://docs.powersync.com/client-sdks/writing-data
 */
export type Change =
  | { op: 'put'; table: string; row: Record<string, Value> }
  | { op: 'patch'; table: string; row: Record<string, Value> }
  | { op: 'del'; table: string; key: Record<string, Value> };

/**
 * Cloud patch operation applied to local synced tables.
 * Put upserts a row by key; del deletes by key; drop drops columns or key ranges; clear wipes all synced tables at pull start.
 * @see https://docs.powersync.com/architecture/powersync-protocol
 */
export type Op =
  | { op: 'put'; table: string; key: Record<string, unknown>; row: Record<string, unknown> }
  | { op: 'del'; table: string; key: Record<string, unknown> }
  | { op: 'drop'; table: string; columns?: string[] }
  | { op: 'drop'; table: string; range: KeyRange }
  | { op: 'clear' };

/** Primary key range bounded by after (exclusive) and until (inclusive) column value dictionaries. */
export type KeyRange = { key: string[]; after?: Record<string, Value>; until?: Record<string, Value> };

/**
 * Notification or final pull chunk carrying a patch of operations up to a commit cookie.
 * Requires device cookie to match base. Reports lmids for confirmed mutations.
 * In a shared space, next allows resuming pulls if intermediate cached chunks were overtaken, and landed encodes the applied subscription.
 */
export type Poke = {
  base: Cookie | null;
  cursor?: string;
  cookie: Cookie;
  lmids: Record<string, number>;
  patch: Op[];
  seen?: number;
  next?: string;
  landed?: string;
  /** Pushed client writes held by the cloud due to validation, foreign-key, or quota failures. */
  held?: { client: string; id: number; reason: string }[];
  /** Primary key range checksum computed on the cloud when requested by pull. */
  checksum?: Checksum;
} & Advice &
  Origin;

/** Table and primary key range covered by a checksum part. */
export type ChecksumPart = { table: string } & KeyRange;

/** Table range requested for rescan during an incremental pull after checksum mismatches. */
export type PullRange = Omit<ChecksumPart, 'key'>;

/**
 * Range checksum comparing row content hashes across contiguous table segments.
 * The final segment includes all synced table names to detect orphaned local rows.
 */
export type Checksum = { parts: ChecksumPart[]; sum: number; rows: number; next?: string; tables?: string[] };

/**
 * Origin metadata identifying the space instance, subscription digest, and incarnation.
 * Mismatched space triggers account switch errors; mismatched incarnation triggers full rebuild resyncs.
 */
type Origin = { space?: string; sub?: string; incarnation?: number };

/**
 * Connection advice from cloud to device.
 * Spread provides reconnect jitter bounds; expiresIn indicates remaining token validity.
 * @see https://github.com/rocicorp/mono/blob/main/packages/zero-protocol/src/error.ts
 */
export type Advice = { spread?: number; expiresIn?: number };

/** Calculates remaining milliseconds until credential expiration. */
export const expiresIn = (expiresAt: number): Advice => (Number.isFinite(expiresAt) ? { expiresIn: expiresAt - Date.now() } : {});

/**
 * Intermediate pull chunk staged locally before landing the final chunk.
 * Cursor and next are opaque pagination tokens. Progress estimates download completion.
 */
export type Chunk = { base: Cookie | null; cursor?: string; next: string; patch: Op[]; progress?: Progress; seen?: number } & Origin;

/**
 * Download progress estimation for multi-chunk pulls.
 * Downloaded and total quantify processed versus estimated byte or row volume.
 * @see https://github.com/powersync-ja/powersync-js/blob/main/packages/common/src/db/crud/SyncProgress.ts
 */
export type Progress = { downloaded: number; total: number };

/** Lightweight WebSocket hint nudging the device to pull over HTTP up to the specified cookie. */
export type Hint = { hint: Cookie } & Advice & Origin;

/** Reset signal returned when a device cookie is off the cloud commit history, instructing a full pull. */
export type Reset = { base: Cookie | null; reset: true } & Origin;

/**
 * WebSocket close code indicating the device must pull over HTTP before reconnecting (custom code 4000).
 * Used when the device lacks a cookie or when its cookie is off history.
 * @see https://www.rfc-editor.org/rfc/rfc6455#section-7.4.2
 */
export const pullNeeded = 4000;

/** WebSocket close code (1011) indicating an unexpected internal error during push processing. */
export const pushFailed = 1011;

/**
 * WebSocket close code (1007) indicating malformed push payloads or unidentifiable mutation sequences.
 * Devices must not retry invalid push frames without fixing the payload.
 * @see https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1
 */
export const invalidPush = 1007;

/**
 * WebSocket close code (1013) indicating write quota or daily write limit exhaustion.
 * Devices retry with backoff.
 * @see https://www.iana.org/assignments/websocket/websocket.xhtml#close-code-number
 */
export const overQuota = 1013;

/** Character size threshold for chunking HTTP pull patches. */
export const chunkLimit = 1_000_000;

/**
 * Maximum UTF-8 byte length for a single WebSocket message.
 * Patches exceeding this threshold trigger lightweight hints directing devices to pull over HTTP.
 */
export const socketLimit = 24_000;

/** WebSocket close code (4001) indicating expired credentials, prompting the device to refresh authentication. */
export const expired = 4001;

/** WebSocket close code (1008) for a connection a private space at its connection limit closed to take a newer one. */
export const tooManyConnections = 1008;

/**
 * WebSocket close code (1003) for a message the cloud does not take: a binary message, or an upload to a shared space.
 * @see https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1
 */
export const unsupportedMessage = 1003;

/**
 * WebSocket subprotocol and token prefix.
 * Passes credentials in the Sec-WebSocket-Protocol header to prevent leaking tokens into URL access logs.
 * @see https://www.rfc-editor.org/rfc/rfc6455#section-4.1
 * @see https://github.com/rocicorp/mono/blob/main/packages/zero-client/src/client/zero.ts
 */
export const subprotocol = 'syncline';
export const bearer = 'bearer.';

/**
 * Decodes the token from a bearer subprotocol: devices percent-encode bytes outside RFC 3986 unreserved characters so any token forms
 * a valid subprotocol (browsers accept only RFC 7230 tokens, and commas would split the header). Returns undefined if malformed.
 * @see https://www.rfc-editor.org/rfc/rfc3986#section-2.3
 */
export function bearerToken(encoded: string) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/** WebSocket heartbeat messages. Ping is answered with automatic Durable Object pong replies. */
export const ping = 'ping';
export const pong = 'pong';

/**
 * Maximum number of client mutations accepted in a single push batch.
 * Limits server CPU consumption per push request.
 */
export const pushMutations = 1000;

/** Formats a cookie into its string representation `version.nonce`. */
export const formatCookie = ({ version, nonce }: Cookie) => `${version}.${nonce}`;
