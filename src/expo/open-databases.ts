import { report } from '../common/listeners.ts';

/**
 * Coordinates single-instance ownership of open local databases within a process between foreground and background tasks.
 *
 * Opening the same database twice would create two independent device sync state machines competing for the same file.
 * When a background task wakes up while the database is already open, syncOnce shares that open instance without closing it.
 * If the user opens the app while syncOnce is running, foreground adopts the database for that owner so syncOnce does not close it.
 * If the background database belongs to a different owner, foreground closes it before opening its own instance, failing that syncOnce.
 * Used only on mobile (web has no background tasks).
 * What this module must not know: How databases are opened or how sync proceeds internally.
 */

type Database = { sync(options?: { signal?: AbortSignal }): Promise<void>; close(): Promise<void> };

/** Tracked open instance: owner (private space owner) and whether opened by background syncOnce task not yet adopted by foreground. */
type Entry<D> = { database: D; owner: string | undefined; background: boolean };

export class OpenDatabases<D extends Database> {
  readonly #opened = new Map<string, Entry<D>>();

  /**
   * Opens database in foreground, adopting an existing background instance for the same owner or closing one of a different owner.
   *
   * Throws if already open in the foreground. The caller must call closed as soon as close is invoked on the created instance.
   */
  open(name: string, owner: string | undefined, create: () => D): D {
    const running = this.#opened.get(name);
    if (running?.background && running.owner === owner) {
      running.background = false;
      return running.database;
    }
    if (running && !running.background)
      throw new Error(`Local database ${name} is already open: close it first, or reuse the open instance`);
    if (running) {
      this.#opened.delete(name);
      running.database.close().catch(report);
    }
    const database = create();
    this.#opened.set(name, { database, owner, background: false });
    return database;
  }

  /** Marks a database closed as soon as close is initiated without waiting for completion, so it is no longer considered open. */
  closed(name: string, database: D) {
    if (this.#opened.get(name)?.database === database) this.#opened.delete(name);
  }

  /** Runs single sync pass in background task, reusing open instance if present or opening temporary instance and closing on completion. */
  async syncOnce(name: string, owner: string | undefined, create: () => D, options?: { signal?: AbortSignal }) {
    const running = this.#opened.get(name);
    if (running) return running.database.sync(options);
    const database = this.open(name, owner, create);
    const entry = this.#opened.get(name) as Entry<D>;
    entry.background = true;
    try {
      await database.sync(options);
    } finally {
      if (this.#opened.get(name) === entry && entry.background) await database.close();
    }
  }
}
