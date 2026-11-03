import { DurableObject } from 'cloudflare:workers';
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

type Storage = Pick<DurableObjectStorage, 'getAlarm' | 'setAlarm' | 'deleteAlarm'> & { sql: Pick<SqlStorage, 'exec'> };

export class Schedule {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  /** Schedules chore name to run no later than at epoch ms, preserving earlier scheduled times or active backoff. */
  by(name: string, at: number) {
    this.#storage.sql.exec(
      // Avoid updating unchanged rows to minimize billed SQLite row writes on opens and writes.
      'INSERT INTO _syncline_schedule (name, at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET at = excluded.at WHERE failures = 0 AND excluded.at < at',
      name,
      at,
    );
  }

  /** Reschedules chore name unconditionally to at epoch ms, resetting any active failure backoff. */
  at(name: string, at: number) {
    this.#storage.sql.exec('INSERT OR REPLACE INTO _syncline_schedule (name, at) VALUES (?, ?)', name, at);
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
   * Clears due entries before running so new writes can reschedule, then arms the alarm for the next earliest due time.
   */
  async run(chores: (name: string) => Chore | undefined, scheduled: (name: string) => void | Promise<void>) {
    const due = this.#storage.sql
      .exec('DELETE FROM _syncline_schedule WHERE at <= ? RETURNING name, failures', Date.now())
      .toArray()
      .map(({ name, failures }) => ({ name: String(name), failures: Number(failures) }));
    await Promise.all(
      due.map(({ name, failures }) =>
        name.startsWith(reserved) ? this.#chore(name, failures, chores(name)) : this.#scheduled(name, scheduled),
      ),
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

/** Reserved prefix for internal Syncline chores in _syncline_schedule. */
export const reserved = 'syncline:';

/** Base Durable Object managing alarms via a schedule table for internal chores and integrator callbacks. */
export abstract class ScheduledObject<Env> extends DurableObject<Env> {
  /** Schedule table manager for internal chores; integrators use schedule and unschedule. */
  protected readonly timetable: Schedule;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.timetable = new Schedule(ctx.storage);
  }

  /** Schedules an integrator callback to run no later than at epoch ms; name must not start with syncline:. */
  protected readonly schedule = (name: string, at: number) => this.timetable.own(name, at);

  protected readonly unschedule = (name: string) => this.timetable.disown(name);

  /** Invoked when an integrator scheduled task is due; subclasses may override. */
  protected scheduled: (name: string) => void | Promise<void> = () => undefined;
}

const doubling = ({ base, max }: Backoff, failures: number) => Math.min(max, base * 2 ** (failures - 1));
