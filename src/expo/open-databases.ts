import { report } from '../common/listeners.ts';

/**
 * Coordinates single-instance ownership of open local databases within a process between foreground and background tasks.
 *
 * Opening the same database twice would create two independent device sync state machines competing for the same file.
 * When a background task wakes up while the database is already open, syncOnce shares that open instance without closing it.
 * If the user opens the app while syncOnce is running, foreground closes the background instance and opens its own, so its options
 * (token, schema, owner, validation) always take effect; the superseded syncOnce resolves.
 * Used only on mobile (web has no background tasks).
 * What this module must not know: How databases are opened or how sync proceeds internally.
 */

type Database = { sync(options?: { signal?: AbortSignal }): Promise<void>; close(): Promise<void> };

/** Tracked open instance, whether a background syncOnce task opened it, and whether the foreground closed it to open its own. */
type Entry<D> = { database: D; background: boolean; superseded?: true };

export class OpenDatabases<D extends Database> {
  readonly #opened = new Map<string, Entry<D>>();

  /**
   * Opens database in foreground, closing an instance a background syncOnce opened.
   *
   * Throws if already open in the foreground. The caller must call closed as soon as close is invoked on the created instance.
   */
  open(name: string, create: () => D): D {
    const running = this.#opened.get(name);
    if (running && !running.background)
      throw new Error(`Local database ${name} is already open: close it first, or reuse the open instance`);
    if (running) {
      running.superseded = true;
      this.#opened.delete(name);
      running.database.close().catch(report);
    }
    const database = create();
    this.#opened.set(name, { database, background: false });
    return database;
  }

  /** Marks a database closed as soon as close is initiated without waiting for completion, so it is no longer considered open. */
  closed(name: string, database: D) {
    if (this.#opened.get(name)?.database === database) this.#opened.delete(name);
  }

  /**
   * Runs single sync pass in background task, reusing open instance if present or opening temporary instance and closing on completion.
   * Resolves without syncing further if the foreground closes the instance to open its own, which syncs from then on.
   */
  async syncOnce(name: string, create: () => D, options?: { signal?: AbortSignal }) {
    const running = this.#opened.get(name);
    const entry = running ?? { database: this.open(name, create), background: true };
    if (!running) this.#opened.set(name, entry);
    try {
      await entry.database.sync(options);
    } catch (error) {
      if (!entry.superseded) throw error;
    } finally {
      if (!running && this.#opened.get(name) === entry) await entry.database.close();
    }
  }
}
