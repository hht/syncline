// Reference state for schedule simulations: model/Schedule.tla translated action by action (same names, same order of effects),
// so the expected schedule table comes from the model rather than from the implementation.

/** Time classes: an entry is due now, after a lease (15 minutes), or after a pause (a day). */
export type When = 'due' | 'lease' | 'day';

/** State of model/Schedule.tla, with its actions as methods and its invariants as checks that throw. */
export class ScheduleModel {
  readonly present = new Map<string, boolean>();
  readonly at = new Map<string, When>();
  readonly leased = new Map<string, boolean>();
  readonly backoff = new Map<string, boolean>();
  readonly resets = new Map<string, number>();
  alarm = false;
  running = new Set<string>();
  /** Ghost: a scheduling call not yet served by a run that started after it. */
  readonly wanted = new Map<string, boolean>();
  /** Ghost: tasks whose current run started after their last scheduling call. */
  readonly started = new Set<string>();
  /** Ghost: runs of each crasher since the last day tick. */
  readonly crashes = new Map<string, number>();
  faults = 0;
  requests = 0;

  readonly tasks: string[];
  readonly crashers: Set<string>;
  readonly replaced: Set<string>;
  readonly resetLimit: number;

  constructor(tasks: string[], crashers: Set<string>, replaced: Set<string>, resetLimit: number) {
    this.tasks = tasks;
    this.crashers = crashers;
    this.replaced = replaced;
    this.resetLimit = resetLimit;
    for (const t of tasks) {
      this.present.set(t, false);
      this.at.set(t, 'due');
      this.leased.set(t, false);
      this.backoff.set(t, false);
      this.resets.set(t, 0);
      this.wanted.set(t, false);
      this.crashes.set(t, 0);
    }
  }

  #want(t: string) {
    this.requests += 1;
    this.wanted.set(t, true);
    this.started.delete(t);
  }

  /** By (release) or Ensure: insert if missing; release a lease (By only); otherwise move earlier unless backing off. */
  schedule(t: string, when: When, release: boolean) {
    this.#want(t);
    if (!this.present.get(t)) {
      this.present.set(t, true);
      this.at.set(t, when);
    } else if (this.leased.get(t) && release) {
      this.at.set(t, when);
      this.leased.set(t, false);
      this.backoff.set(t, false);
    } else if (!this.leased.get(t) && !this.backoff.get(t) && when === 'due' && this.at.get(t) !== 'due') {
      this.at.set(t, when);
    }
  }

  /** At: replaces the entry outright. */
  replace(t: string, when: When) {
    this.#want(t);
    this.present.set(t, true);
    this.at.set(t, when);
    this.leased.set(t, false);
    this.backoff.set(t, false);
    this.resets.set(t, 0);
  }

  cancel(t: string) {
    this.requests += 1;
    this.present.set(t, false);
    this.leased.set(t, false);
    this.backoff.set(t, false);
    this.resets.set(t, 0);
    this.wanted.set(t, false);
  }

  dueNow() {
    return this.tasks.filter((t) => this.present.get(t) && this.at.get(t) === 'due');
  }

  #start(batch: string[]) {
    for (const t of batch) {
      this.leased.set(t, true);
      this.at.set(t, 'lease');
      this.resets.set(t, (this.resets.get(t) as number) + 1);
      if (this.crashers.has(t)) this.crashes.set(t, (this.crashes.get(t) as number) + 1);
      this.started.add(t);
    }
    this.alarm = true;
    this.running = new Set(batch);
  }

  /**
   * The alarm fires and returns the tasks it starts (none when a suspect pauses). Among the suspects with the fewest resets the model
   * picks any; this refinement picks the first by name, as the implementation orders them.
   */
  fire() {
    const suspects = this.dueNow().filter((t) => (this.resets.get(t) as number) > 0);
    if (suspects.length === 0) {
      const batch = this.dueNow();
      this.#start(batch);
      return batch;
    }
    const fewest = Math.min(...suspects.map((t) => this.resets.get(t) as number));
    const s = suspects.filter((t) => this.resets.get(t) === fewest).sort()[0] as string;
    if ((this.resets.get(s) as number) >= this.resetLimit) {
      this.at.set(s, 'day');
      this.backoff.set(s, true);
      this.leased.set(s, false);
      this.resets.set(s, this.resetLimit - 1);
      return [];
    }
    this.#start([s]);
    return [s];
  }

  finish(t: string) {
    this.running.delete(t);
    this.alarm = this.running.size > 0;
    this.resets.set(t, 0);
    if (this.leased.get(t)) {
      this.present.set(t, false);
      this.leased.set(t, false);
      this.backoff.set(t, false);
      if (this.started.has(t)) this.wanted.set(t, false);
    }
  }

  /** The object resets mid-alarm: a crasher's run, or an external reset (counted in faults). */
  reset() {
    if (![...this.running].some((t) => this.crashers.has(t))) this.faults += 1;
    this.alarm = false;
    this.running = new Set();
    for (const t of this.replaced) {
      this.leased.set(t, false);
      this.backoff.set(t, false);
      this.resets.set(t, 0);
    }
  }

  idle() {
    return !this.alarm && this.dueNow().length === 0;
  }

  /** Whether some entry is in time class `when` (a tick moving it to due can happen). */
  holds(when: When) {
    return this.tasks.some((t) => this.present.get(t) && this.at.get(t) === when);
  }

  leaseTick() {
    for (const t of this.tasks) if (this.at.get(t) === 'lease') this.at.set(t, 'due');
  }

  dayTick() {
    for (const t of this.tasks) {
      if (this.at.get(t) !== 'due') this.at.set(t, 'due');
      this.crashes.set(t, 0);
    }
  }

  /** Throws unless Kept, Bounded, and Exempt hold. */
  check() {
    for (const t of this.tasks) {
      if (this.wanted.get(t) && !this.present.get(t)) throw new Error(`Kept violated: ${t} was scheduled but has no entry`);
      if (this.crashers.has(t) && (this.crashes.get(t) as number) > this.resetLimit) throw new Error(`Bounded violated: ${t}`);
      if (this.replaced.has(t) && this.backoff.get(t)) throw new Error(`Exempt violated: ${t} backs off`);
    }
  }
}
