import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Change } from '../common/protocol.ts';
import type { Schema } from '../tables/table-definitions.ts';
import type { Validation } from '../tables/validation.ts';
import { remoteDatabase } from './remote-database.ts';
import type { SyncStatus } from './status.ts';

/**
 * Provides the application-facing Syncline interface: local SQLite database with Drizzle ORM, private and shared spaces,
 * sync status, and lifecycle methods.
 *
 * Wraps the cross-platform Client (backed by the Rust engine) in developer-friendly TypeScript APIs.
 * What this module must not know: Storage location, platform-specific thread models, or internal sync protocol mechanics.
 */

export type { Schema } from '../tables/table-definitions.ts';

/** Drizzle database proxy for local database reads and writes. */
export type Database = ReturnType<typeof remoteDatabase>;

type Execute = (sql: string, params: unknown[]) => Promise<unknown[][]>;

/** Local mutation held by the cloud space: rejection reason and raw row changes. */
export type Held = { reason: string; changes: Change[] };

/** Local database interface required from Client. */
export type LocalDatabase = {
  query: Execute;
  tablesOf(sql: string): Promise<string[]>;
  write<T>(body: (execute: Execute) => Promise<T>): Promise<T>;
  onChange(listener: (tables: ReadonlySet<string>) => void): () => void;
  onHeld(listener: (writes: Held[]) => void): () => void;
};

/** Sync channel interface for a space required from Client. */
export type Channel = {
  waitForReady(): Promise<void>;
  status(): SyncStatus;
  onStatus(listener: (status: SyncStatus) => void): () => void;
  sync(options?: { signal?: AbortSignal }): Promise<void>;
  resync(options?: { signal?: AbortSignal; discardPending?: boolean }): Promise<void>;
  reconnect(): void;
};

/** Platform operations supplied by native or web host bindings. */
export type Platform = {
  shared(name: string, tables: SQLiteTable[], url: string, token: () => Promise<string>, userID?: string): Channel;
  close(): Promise<void>;
  delete(): Promise<void>;
};

/** Configuration options for opening a local database. */
export type OpenOptions<S extends Schema = Schema> = {
  /** Database name identifying the local SQLite database file. */
  name: string;
  /**
   * ID of the signed-in user the private space belongs to (an app with one user passes a constant): if it differs from the one recorded,
   * clears the previous user's data while preserving shared spaces. If the previous user left un-uploaded pending writes, opening fails
   * with PendingWritesError unless discardPending is set. Required, so data of one user never shows to the next.
   */
  userID: string;
  /** Discards un-uploaded pending writes from a previous user when switching users; ignored by syncOnce. */
  discardPending?: boolean;
  schema: S;
  /** Local-only tables stored in the database but never uploaded or downloaded; cleared on account switch. */
  localOnly?: Schema;
  /** Retired tables and columns ("table.column") permanently removed from sync, never declared again; dropped on open while a space records them. */
  retired?: string[];
  /** Private space sync endpoint URL (HTTPS), used for both WebSocket and HTTP downloads. Must not contain query parameters or '#'; otherwise the space fails with downloadError. */
  url: string;
  /** Accepts HTTP sync URLs (private and shared spaces), sending tokens and rows in cleartext; for local development only. */
  allowCleartext?: boolean;
  /** Authentication token getter called before connecting. */
  token: () => Promise<string>;
  validation?: Validation;
  /** Synced tables modified exclusively by the cloud; local writes throw. */
  readOnly?: SQLiteTable[];
  /** Maximum number of rows verified daily by online checksums (default 1,000,000). */
  checksumRowsPerDay?: number;
};

const channelOf = (channel: Channel) => ({
  /**
   * Resolves once the space is open and syncing starts, without waiting for the network; rejects with the reason it cannot open (such as
   * PendingWritesError or an invalid URL), which downloadError also shows. Rules checked in JavaScript throw from the opening call instead.
   * A shared space creates its tables in the background: if that fails, this still resolves and downloadError shows the failure.
   */
  waitForReady: () => channel.waitForReady(),
  /** Current synchronization status snapshot. */
  status: () => channel.status(),
  /** Subscribes to sync status changes, returning an unsubscribe callback. */
  onStatus: (listener: (status: SyncStatus) => void) => channel.onStatus(listener),
  /** Waits for synchronization to catch up to head and confirm all local writes. */
  sync: (options?: { signal?: AbortSignal }) => channel.sync(options),
  /** Downloads a fresh copy of synced tables; preserves pending writes by default unless discardPending is true. */
  resync: (options?: { signal?: AbortSignal; discardPending?: boolean }) => channel.resync(options),
  /** Reconnects immediately and fetches a fresh token, useful on authentication changes. */
  reconnect: () => channel.reconnect(),
});

/** Wraps local database operations and sync channels into the public Syncline database interface. */
export function syncline(name: string, local: LocalDatabase, channel: Channel, platform: Platform, token: () => Promise<string>) {
  const db = remoteDatabase(local.query);
  /** Open shared space channels by name to deduplicate in React StrictMode effects. */
  const opened = new Map<string, { url: string; userID: string | undefined; channel: ReturnType<typeof channelOf> & { name: string } }>();
  return {
    name,
    /** Read-only Drizzle database proxy. */
    db,
    /** Executes a local write transaction with read-write Drizzle database proxy, rolling back on error and syncing changes on commit. */
    write: <T>(body: (tx: Database) => Promise<T>) => local.write((execute) => body(remoteDatabase(execute))),
    /** Subscribes to table change notifications from local writes, cloud patches, or resets, returning an unsubscribe callback. */
    onChange: (listener: (tables: ReadonlySet<string>) => void) => local.onChange(listener),
    /** Returns table names read by a SQL query without executing it. */
    tablesOf: (sql: string) => local.tablesOf(sql),
    /** Subscribes to notifications when client mutations are held by the cloud space, returning an unsubscribe callback. */
    onHeld: (listener: (writes: Held[]) => void) => local.onHeld(listener),
    ...channelOf(channel),
    /**
     * Opens a shared space (device-read-only) in the same database.
     *
     * Table names must not collide with private space or other shared spaces. Reopening returns the open instance.
     * If token is omitted, defaults to the private space token getter.
     * Row visibility is determined by the cloud space according to authorized buckets.
     * If userID differs from the previous session, previously viewed shared data is cleared to prevent data leakage across users.
     * Query shared tables through db as usual; onChange notifications fire together.
     */
    openShared: (sharedName: string, options: { schema: Schema; url: string; token?: () => Promise<string>; userID?: string }) => {
      const known = opened.get(sharedName);
      if (known?.url === options.url && known.userID === options.userID) return known.channel;
      if (known) throw new Error(`Shared space ${sharedName} is already open with a different URL or user`);
      const shared = {
        name: sharedName,
        ...channelOf(platform.shared(sharedName, Object.values(options.schema), options.url, options.token ?? token, options.userID)),
      };
      opened.set(sharedName, { url: options.url, userID: options.userID, channel: shared });
      return shared;
    },
    /** Stops synchronization and closes the database; subsequent operations fail. */
    close: () => platform.close(),
    /** Closes database and deletes database files from disk. */
    delete: () => platform.delete(),
  };
}

export type Syncline = ReturnType<typeof syncline>;

/** A shared space opened by `openShared`. */
export type SharedSpace = ReturnType<Syncline['openShared']>;
