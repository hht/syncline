import { DurableObject } from 'cloudflare:workers';
import { report } from '../common/listeners.ts';

/**
 * 一个 Durable Object 只有一个 alarm（setAlarm 盖掉之前排的）：各方要在什么时刻做什么登记在 _syncline_schedule（导出、共用空间的重发与定时醒、
 * 接入方自己的定时），alarm 总排在最早的那一件。登记是一行 SQL，与这次的写一起提交；排 alarm 在登记之后，排之前对象重启了，
 * 下次醒来（构造时）照登记的重排。Syncline 自己的事（Chore）每次做一步：没做完就马上再排一次，出错按退避重排、一直重试到成功，
 * 连着失败了几次记在登记的那一行（平台对抛错的 alarm 重试有次数上限，要一直重试就在 alarm 里接住、自己排下一次）。
 * 不该知道的：每件事是什么、怎么做。
 * @see https://developers.cloudflare.com/durable-objects/api/alarms/
 */

/** 出错后的退避：第 n 次连着失败后等 min(max, base × 2^(n-1)) 毫秒 */
type Backoff = { base: number; max: number };

/** Syncline 自己的一件事：run 做一步，返回 true 是还没做完（马上再排一次）；抛错交给 failed（报给接入方）、按 retry 退避重排 */
export type Chore = { run: () => Promise<boolean>; retry: Backoff; failed: (error: unknown) => void };

type Storage = Pick<DurableObjectStorage, 'getAlarm' | 'setAlarm' | 'deleteAlarm'> & { sql: Pick<SqlStorage, 'exec'> };

export class Schedule {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  /** 名为 name 的事最迟在 at 做：已经排得更早、或在出错后的退避中（不提前）就不动 */
  by(name: string, at: number) {
    this.#storage.sql.exec(
      // 不动的不改写：每次打开对象、每次写都会登记，行写按行计费
      'INSERT INTO _syncline_schedule (name, at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET at = excluded.at WHERE failures = 0 AND excluded.at < at',
      name,
      at,
    );
  }

  /** 名为 name 的事改在 at 做（可以推后），不再算在退避中 */
  at(name: string, at: number) {
    this.#storage.sql.exec('INSERT OR REPLACE INTO _syncline_schedule (name, at) VALUES (?, ?)', name, at);
  }

  cancel(name: string) {
    this.#storage.sql.exec('DELETE FROM _syncline_schedule WHERE name = ?', name);
  }

  /** 名为 name 的事排在什么时刻；没排是 undefined */
  when(name: string) {
    const [row] = this.#storage.sql.exec('SELECT at FROM _syncline_schedule WHERE name = ?', name).toArray();
    return row ? Number(row.at) : undefined;
  }

  /** 接入方自己的定时（名字不能以 syncline: 开头）：最迟在 at 做，同名的再登记就改成更早的那个；登记完重排 alarm */
  own(name: string, at: number) {
    this.#check(name);
    this.by(name, at);
    void this.arm();
  }

  /** 撤掉接入方自己的一件定时，重排 alarm */
  disown(name: string) {
    this.#check(name);
    this.cancel(name);
    void this.arm();
  }

  #check(name: string) {
    if (name.startsWith(reserved)) throw new Error(`定时的名字不能以 ${reserved} 开头：${name}`);
  }

  /**
   * alarm 到了：到时候了的各件同时做、各管各的（一件卡住或在退避，不占别的时间）。Syncline 自己登记的交给 chores 认出是哪件事（不认得的跳过），
   * 做一步：没做完马上再排，出错交给它的 failed、按它的退避重排（期间登记的更早的时刻不算）；接入方的交给 scheduled，出错照常报出、不挡别的。
   * 做完把 alarm 排到下一件。先删后做（做的时候可以重新登记下一次，有了新的写也照常登记）：做到一半对象被重置（部署、超出平台的上限），
   * 这次就丢了、连着失败的次数也一起丢了，由下一次登记补上
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

  /** alarm 排到登记里最早的那件；没有了就删掉 alarm */
  async arm() {
    const [row] = this.#storage.sql.exec('SELECT min(at) AS at FROM _syncline_schedule').toArray();
    const at = row?.at === null || row?.at === undefined ? undefined : Number(row.at);
    const current = await this.#storage.getAlarm();
    if (at === undefined) {
      if (current !== null) await this.#storage.deleteAlarm();
    } else if (current !== at) await this.#storage.setAlarm(at);
  }
}

/** 接入方自己的定时不能以它开头：留给 Syncline 自己登记的 */
export const reserved = 'syncline:';

/**
 * 用定时表管 alarm 的 Durable Object（私有空间与共用空间都是）：接入方自己的定时（schedule、unschedule、scheduled）在这里，
 * Syncline 自己的事由子类登记在 timetable 上、在 alarm 里交给它的 run
 */
export abstract class ScheduledObject<Env> extends DurableObject<Env> {
  /** 定时表：Syncline 自己登记的事（子类用）；接入方用 schedule、unschedule */
  protected readonly timetable: Schedule;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.timetable = new Schedule(ctx.storage);
  }

  /** 接入方自己的定时：最迟在 at（毫秒）调 scheduled(name)；同名的再登记就改成更早的那个。name 不能以 syncline: 开头 */
  protected readonly schedule = (name: string, at: number) => this.timetable.own(name, at);

  protected readonly unschedule = (name: string) => this.timetable.disown(name);

  /** 接入方登记的定时到了：子类覆盖它（写成实例上的函数）；出错照常报出，不挡别的 */
  protected scheduled: (name: string) => void | Promise<void> = () => undefined;
}

const doubling = ({ base, max }: Backoff, failures: number) => Math.min(max, base * 2 ** (failures - 1));
