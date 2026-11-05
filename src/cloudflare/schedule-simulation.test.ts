import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { random, stepped } from '../test/test-random.ts';
import { ScheduleModel, type When } from '../test/test-schedule.ts';
import { lease, Schedule } from './schedule.ts';

// Schedule simulation: a random seed picks the actions of model/Schedule.tla (By, Ensure, At, and cancel calls; the alarm firing;
// tasks finishing; crashers and external resets cutting the alarm; leases and days passing) and drives the Schedule class with them
// on SQLite under a fake clock. Task a finishes, c resets the object every run, d is a delivery rescheduled with At. A reset drops the
// runs in memory and replays what an object start does (replacing the delivery entry at its time, arming the alarm). After every step
// the schedule table must match the model entry by entry (time class, lease, backoff, resets), every task the alarm starts must be one
// the model starts, and the alarm must be armed for the earliest entry; a final phase without new calls checks every call is served.
// @see https://apple.github.io/foundationdb/testing.html

const tasks = ['a', 'c', 'd'];
const crashers = new Set(['c']);
const replaced = new Set(['d']);
/** Unfinished runs in a row before a task pauses a day, as the schedule counts them. */
const resetLimit = 3;
const maxFaults = 3;
const day = 86_400_000;

let clock = 0;
const reported: unknown[] = [];
beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.stubGlobal('reportError', (error: unknown) => reported.push(error));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sqlite3 = await sqlite3InitModule();

/** In-memory schedule table with the schema the cloud creates; exec returns rows the way Durable Object SQL storage does, as the schedule reads them. */
function scheduleTable() {
  const db = new sqlite3.oo1.DB(':memory:');
  db.exec(
    'CREATE TABLE _syncline_schedule (name TEXT PRIMARY KEY, at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, resets INTEGER NOT NULL DEFAULT 0)',
  );
  return {
    exec: (sql: string, ...bind: (string | number)[]) => {
      const rows = db.exec({ sql, bind, returnValue: 'resultRows', rowMode: 'object' });
      return { toArray: () => rows };
    },
  };
}

/** Lets the alarm's promises settle (the schedule awaits storage calls between steps). */
const flush = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
};

class Simulation {
  readonly steps: string[] = [];
  readonly #model = new ScheduleModel(tasks, crashers, replaced, resetLimit);
  readonly #sql = scheduleTable();
  #alarm: number | null = null;
  readonly #schedule = new Schedule({
    sql: this.#sql as unknown as Pick<SqlStorage, 'exec'>,
    getAlarm: async () => this.#alarm,
    setAlarm: async (at: number | Date) => {
      this.#alarm = Number(at);
    },
    deleteAlarm: async () => {
      this.#alarm = null;
    },
    sync: async () => undefined,
  });
  /** Runs in memory: resolving one finishes it; a reset drops them all unfinished. */
  #runs = new Map<string, () => void>();
  #pauses = 0;
  readonly #random: () => number;

  constructor(seed: number) {
    this.#random = random(seed);
    clock = 1_000_000_000_000;
    reported.length = 0;
  }

  #pick<T>(items: T[]) {
    return items[Math.floor(this.#random() * items.length)] as T;
  }

  /** Scheduling calls the model enables now, with their weights. */
  #calls(): [number, () => Promise<void>][] {
    const model = this.#model;
    const call =
      (name: string, from: string[], real: (t: string, at: number) => void, expected: (t: string, when: When) => void) => async () => {
        const t = this.#pick(from);
        const when = this.#pick<When>(['due', 'lease']);
        this.steps.push(`${name}(${t}, ${when})`);
        real(t, when === 'due' ? clock : clock + lease);
        expected(t, when);
        // Every caller arms the alarm after scheduling
        await this.#schedule.arm();
      };
    const schedule = this.#schedule;
    return [
      [
        3,
        call(
          'by',
          tasks,
          (t, at) => schedule.by(t, at),
          (t, when) => model.schedule(t, when, true),
        ),
      ],
      [
        model.alarm ? 0 : 1,
        call(
          'ensure',
          ['a', 'c'],
          (t, at) => schedule.ensure(t, at),
          (t, when) => model.schedule(t, when, false),
        ),
      ],
      [
        1,
        call(
          'at',
          [...replaced],
          (t, at) => schedule.at(t, at),
          (t, when) => model.replace(t, when),
        ),
      ],
      [
        model.present.get('a') ? 1 : 0,
        call(
          'cancel',
          ['a'],
          (t) => schedule.cancel(t),
          (t) => model.cancel(t),
        ),
      ],
    ];
  }

  /** Actions the model enables now with their weights; `calls` adds scheduling calls and external resets. */
  #actions(calls: boolean): [number, () => Promise<void>][] {
    const model = this.#model;
    const crashing = [...model.running].some((t) => crashers.has(t));
    const finishing = [...model.running].filter((t) => !crashers.has(t));
    return [
      ...(calls ? this.#calls() : []),
      [!model.alarm && model.dueNow().length > 0 ? 3 : 0, () => this.#fire()],
      [finishing.length > 0 ? 3 : 0, () => this.#finish(this.#pick(finishing))],
      [model.alarm && (crashing || (calls && model.faults < maxFaults)) ? 1 : 0, () => this.#reset()],
      [model.idle() && model.holds('lease') ? 1 : 0, async () => this.#tick('leaseTick', lease, () => model.leaseTick())],
      [model.idle() && model.holds('day') ? 1 : 0, async () => this.#tick('dayTick', day, () => model.dayTick())],
    ];
  }

  /** Takes one enabled action, if any. */
  async step(calls: boolean) {
    const enabled = this.#actions(calls).flatMap(([weight, action]) => Array<() => Promise<void>>(weight).fill(action));
    if (enabled.length === 0) return;
    await this.#pick(enabled)();
    this.check();
  }

  async #fire() {
    const started: string[] = [];
    const run = (name: string) =>
      new Promise<void>((resolve) => {
        started.push(name);
        // A crasher never finishes: its run ends only in a reset
        if (!crashers.has(name)) this.#runs.set(name, resolve);
      });
    // The handler sees no alarm until it sets one
    // @see https://developers.cloudflare.com/durable-objects/api/alarms/#getalarm
    this.#alarm = null;
    void this.#schedule.run(() => undefined, run);
    await flush();
    const batch = this.#model.fire();
    this.steps.push(`fire [${batch}]`);
    if (batch.length === 0) this.#pauses += 1;
    expect(started.sort()).toEqual([...batch].sort());
  }

  async #finish(t: string) {
    this.steps.push(`finish(${t})`);
    this.#runs.get(t)?.();
    this.#runs.delete(t);
    await flush();
    this.#model.finish(t);
  }

  /** Drops the runs in memory and starts the object again: the delivery entry is replaced at its time, then the alarm armed. */
  async #reset() {
    this.steps.push('reset');
    this.#runs = new Map();
    const at = this.#schedule.when('d');
    if (at !== undefined) this.#schedule.at('d', at);
    await this.#schedule.arm();
    this.#model.reset();
  }

  #tick(name: string, by: number, model: () => void) {
    this.steps.push(name);
    clock += by;
    model();
  }

  /** Whether every scheduling call of a task that finishes was served. */
  served() {
    return tasks.every((t) => crashers.has(t) || !this.#model.wanted.get(t));
  }

  check() {
    const model = this.#model;
    model.check();
    const rows = new Map(
      this.#sql
        .exec('SELECT name, at, failures, resets FROM _syncline_schedule')
        .toArray()
        .map((row) => [String(row.name), { at: Number(row.at), failures: Number(row.failures), resets: Number(row.resets) }]),
    );
    for (const t of tasks) {
      const row = rows.get(t);
      expect([t, row !== undefined]).toEqual([t, model.present.get(t)]);
      if (!row) continue;
      const when: When = row.at <= clock ? 'due' : row.at <= clock + lease ? 'lease' : 'day';
      const leased = model.leased.get(t);
      // Backoff under a lease is never read: the lease ends with the entry or with a By that clears both
      expect({ t, when, leased: row.failures === -1, resets: row.resets, ...(!leased && { backoff: row.failures > 0 }) }).toEqual({
        t,
        when: model.at.get(t),
        leased,
        resets: model.resets.get(t),
        ...(!leased && { backoff: model.backoff.get(t) }),
      });
    }
    // Mid-alarm the fired alarm is still recorded; between alarms it is armed for the earliest entry
    if (!model.alarm) expect(this.#alarm).toBe(rows.size === 0 ? null : Math.min(...[...rows.values()].map(({ at }) => at)));
    expect(reported).toHaveLength(this.#pauses);
  }
}

test.for(Array.from({ length: 500 }, (_, index) => index))(
  'schedule simulation seed %i: schedule table matches model/Schedule.tla after every step, and every call is served',
  async (seed) => {
    const simulation = new Simulation(seed);
    await stepped(seed, simulation.steps, async () => {
      for (let step = 0; step < 40; step++) await simulation.step(true);
      // No more calls or external resets: the fair actions alone serve every call
      for (let step = 0; step < 200 && !simulation.served(); step++) await simulation.step(false);
      expect(simulation.served()).toBe(true);
    });
  },
);
