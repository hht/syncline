import { report } from '../common/listeners.ts';

/**
 * Multiplexes chores and integrator callbacks onto a single Durable Object alarm:
 * rows in _syncline_schedule track execution times and failure counts; the alarm is always set for the earliest due time.
 * Chores execute one step per alarm: incomplete chores reschedule immediately, while errors trigger exponential backoff until success.
 * Integrator callbacks run via scheduled, with errors logged without blocking other tasks.
 * @see https://developers.cloudflare.com/durable-objects/api/alarms/
 */

/** Backoff configuration after failure: wait min(max, base * 2^(n-1)) milliseconds after consecutive failure n. */
type Backoff = { base: number; max: number };

/** Background chore definition: run performs one step (returning true if unfinished); errors report to failed and back off. */
export type Chore = { run: () => Promise<boolean>; retry: Backoff; failed: (error: unknown) => void };

type Storage = Pick<DurableObjectStorage, 'getAlarm' | 'setAlarm' | 'deleteAlarm' | 'sync'> & { sql: Pick<SqlStorage, 'exec'> };

export class Schedule {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  /** Schedules chore name to run no later than at epoch ms, preserving earlier scheduled times or active backoff; replaces a lease. */
  by(name: string, at: number) {
    this.#schedule(name, at, true);
  }

  /**
   * Schedules chore name like {@link by} but keeps a lease, for work found pending when the object starts: a leased entry runs when its
   * lease ends, and on a restart it may be the very task whose reset restarted the object.
   */
  ensure(name: string, at: number) {
    this.#schedule(name, at, false);
  }

  #schedule(name: string, at: number, release: boolean) {
    this.#storage.sql.exec(
      // Avoid updating unchanged rows to minimize billed SQLite row writes on opens and writes.
      'INSERT INTO _syncline_schedule (name, at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET at = excluded.at, failures = 0 WHERE (failures = ? AND ?) OR (failures = 0 AND excluded.at < at)',
      name,
      at,
      leased,
      release ? 1 : 0,
    );
  }

  /** Reschedules chore name unconditionally to at epoch ms, resetting any active failure backoff. */
  at(name: string, at: number) {
    this.#storage.sql.exec(
      // Writes nothing when the entry already holds this time with no backoff: replacing the row would bill it and its index row again.
      'INSERT INTO _syncline_schedule (name, at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET at = excluded.at, failures = 0, resets = 0 WHERE at <> excluded.at OR failures <> 0 OR resets <> 0',
      name,
      at,
    );
  }

  cancel(name: string) {
    this.#storage.sql.exec('DELETE FROM _syncline_schedule WHERE name = ?', name);
  }

  /** Returns the scheduled epoch ms for chore name, or undefined if not scheduled. */
  when(name: string) {
    const [row] = this.#storage.sql.exec('SELECT at FROM _syncline_schedule WHERE name = ?', name).toArray();
    return row ? Number(row.at) : undefined;
  }

  /** Schedules an integrator chore due no later than at epoch ms, re-arming the alarm. */
  own(name: string, at: number) {
    this.#check(name);
    // SQLite stores a lone surrogate as-is and reads it back replaced, so the entry would never match its own row again.
    if (!name.isWellFormed()) throw new Error(`Schedule name must be well-formed text (no lone surrogates): ${name}`);
    this.by(name, at);
    void this.arm();
  }

  /** Cancels an integrator chore by name and re-arms the alarm. */
  disown(name: string) {
    this.#check(name);
    this.cancel(name);
    void this.arm();
  }

  #check(name: string) {
    if (name.startsWith(reserved)) throw new Error(`Schedule name must not start with ${reserved}: ${name}`);
  }

  /**
   * Executes all due chores and scheduled tasks concurrently when an alarm fires:
   * Syncline chores run via chores (stepping, rescheduling, or backing off on error); integrator tasks run via scheduled.
   * Leases due entries (moving them to the end of the lease, marked leased) rather than deleting them: if the actor resets mid-run,
   * the entry survives and the alarm re-armed on restart runs it again after the lease. The lease is committed before any task runs,
   * since a reset rolls back writes not yet committed, including those of a task that never yields. Scheduling during the run replaces
   * the lease; an entry is deleted on completion only if it still holds its lease. Then arms the alarm for the next earliest due time.
   * An entry whose earlier run never finished may be what reset the object: it runs alone, so the tasks due with it are not cut off
   * again; after resetLimit such runs in a row it waits a day instead and is reported, so a task that never fits resets the object
   * once a day rather than every lease.
   * @see https://developers.cloudflare.com/durable-objects/api/storage-api/#sync
   */
  async run(chores: (name: string) => Chore | undefined, scheduled: (name: string) => void | Promise<void>) {
    const now = Date.now();
    const due = this.#storage.sql
      .exec('SELECT name, failures, resets FROM _syncline_schedule WHERE at <= ? ORDER BY resets, name', now)
      .toArray()
      // An entry still leased here was orphaned by a reset: its backoff count is gone, so it runs as a first attempt.
      .map(({ name, failures, resets }) => ({ name: String(name), failures: Math.max(0, Number(failures)), resets: Number(resets) }));
    const suspect = due.find(({ resets }) => resets > 0);
    if (suspect && suspect.resets >= resetLimit) {
      this.#storage.sql.exec(
        'UPDATE _syncline_schedule SET at = ?, failures = max(failures, 1), resets = ? WHERE name = ?',
        now + resetPause,
        resetLimit - 1,
        suspect.name,
      );
      const error = new Error(
        `${suspect.name} reset the object ${resetLimit} times in a row (exceeding the CPU limit, configurable with limits.cpu_ms, or hanging); retrying in a day`,
      );
      if (suspect.name.startsWith(reserved)) chores(suspect.name)?.failed(error);
      else report(error);
      await this.arm();
      return;
    }
    const batch = suspect ? [suspect] : due;
    for (const { name } of batch)
      this.#storage.sql.exec(
        'UPDATE _syncline_schedule SET at = ?, failures = ?, resets = resets + 1 WHERE name = ?',
        now + lease,
        leased,
        name,
      );
    await this.#storage.sync();
    await Promise.all(
      batch.map(async ({ name, failures }) => {
        try {
          await (name.startsWith(reserved) ? this.#chore(name, failures, chores(name)) : this.#scheduled(name, scheduled));
        } finally {
          // The run finished, so it did not reset the object; only a row it rescheduled is left to clear.
          this.#storage.sql.exec('DELETE FROM _syncline_schedule WHERE name = ? AND failures = ?', name, leased);
          this.#storage.sql.exec('UPDATE _syncline_schedule SET resets = 0 WHERE name = ? AND resets > 0', name);
        }
      }),
    );
    await this.arm();
  }

  async #chore(name: string, failures: number, chore: Chore | undefined) {
    if (!chore) return;
    try {
      if (await chore.run()) this.by(name, Date.now());
    } catch (error) {
      chore.failed(error);
      this.#storage.sql.exec(
        'INSERT OR REPLACE INTO _syncline_schedule (name, at, failures) VALUES (?, ?, ?)',
        name,
        Date.now() + doubling(chore.retry, failures + 1),
        failures + 1,
      );
    }
  }

  async #scheduled(name: string, scheduled: (name: string) => void | Promise<void>) {
    try {
      await scheduled(name);
    } catch (error) {
      report(error);
    }
  }

  /** Arms the alarm for the earliest entry in _syncline_schedule, or deletes the alarm if none remain. */
  async arm() {
    const [row] = this.#storage.sql.exec('SELECT min(at) AS at FROM _syncline_schedule').toArray();
    const at = row?.at === null || row?.at === undefined ? undefined : Number(row.at);
    const current = await this.#storage.getAlarm();
    if (at === undefined) {
      if (current !== null) await this.#storage.deleteAlarm();
    } else if (current !== at) await this.#storage.setAlarm(at);
  }
}

/**
 * How long a running entry stays leased: an alarm invocation cannot run longer (15-minute wall-time limit), so a leased entry is
 * never run twice at once, and an entry orphaned by a reset runs again at most this long after its run started.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */
export const lease = 15 * 60_000;

/** Failure count marking a leased entry (a running entry, or one orphaned by a reset mid-run). */
const leased = -1;

/** Unfinished runs in a row after which an entry waits resetPause instead of its lease before running again. */
const resetLimit = 3;
const resetPause = 86_400_000;

/** Reserved prefix for internal Syncline chores in _syncline_schedule. */
export const reserved = 'syncline:';

const doubling = ({ base, max }: Backoff, failures: number) => Math.min(max, base * 2 ** (failures - 1));
