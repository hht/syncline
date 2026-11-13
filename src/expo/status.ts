import type { Progress } from '../protocol/messages.ts';

/**
 * Defines the synchronization status structure reported by the sync engine and observed by the UI.
 *
 * A new status object is emitted on every change.
 * What this module must not know: How status values are calculated.
 * @see https://github.com/powersync-ja/powersync-js/blob/main/packages/common/src/db/crud/SyncStatus.ts
 */

/** Synchronization status emitted as an immutable snapshot on change. */
export type SyncStatus = {
  /** True when connected to the cloud and caught up, streaming live changes. */
  connected: boolean;
  /** True when started but not yet connected (including token retrieval, HTTP pull, and backoff wait); false when paused for app update. */
  connecting: boolean;
  /** True while an HTTP pull is in progress. */
  downloading: boolean;
  /** HTTP pull progress, present starting from the second chunk (omitted for single-chunk pulls); undefined when not downloading. */
  downloadProgress: Progress | undefined;
  /** Number of pending writes waiting to upload. */
  pending: number;
  /** True if this database has synced before (retains a cookie across restarts, cleared on reset). */
  hasSynced: boolean;
  /** Error from token retrieval, HTTP pull, or WebSocket connection; cleared on receiving next chunk or catching up to head. */
  downloadError: Error | undefined;
  /** Error from cloud push processing; cleared when subsequent writes are confirmed by the cloud. */
  uploadError: Error | undefined;
  /** True when cloud protocolVersion is newer than supported or schema accesses retired tables/columns; sync paused until app update. */
  updateNeeded: boolean;
};

/** Offline defaults when disconnected. */
export const offline = { connected: false, connecting: false, downloading: false, downloadProgress: undefined };
