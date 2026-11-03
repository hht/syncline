import { report } from '../common/listeners.ts';

/**
 * 一个进程里一个本机库只开一份（同一个库开两份就是两个 Device 各自排队写同一个文件），前台打开与后台任务的 syncOnce 怎么共用这一份：
 * 后台任务被叫醒时 App 还开着库，syncOnce 就用开着的那份、不关；syncOnce 开着时用户点开了 App，前台接管同一个人的那份，syncOnce 同步完不再关它；
 * 开着的是别人的（换了人登录），前台先关掉它再开自己的，那次 syncOnce 随之失败。只在手机上用（web 没有后台任务）。
 * 不该知道的：库怎么打开、同步怎么进行。
 */

type Database = { sync(options?: { signal?: AbortSignal }): Promise<void>; close(): Promise<void> };

/** 开着的一份：主人（私有空间属于谁），是不是后台任务的 syncOnce 开的、还没被前台接管 */
type Entry<D> = { database: D; owner: string | undefined; background: boolean };

export class OpenDatabases<D extends Database> {
  readonly #opened = new Map<string, Entry<D>>();

  /**
   * 前台打开：后台任务开着同一个人的就接管它，开着别人的就先关掉它（不等关完：新开的在原生一侧等旧的关完才开库文件）；前台已经开着（重复打开）就抛错。
   * create 开出的库关库时（一调用就算）要调 closed
   */
  open(name: string, owner: string | undefined, create: () => D): D {
    const running = this.#opened.get(name);
    if (running?.background && running.owner === owner) {
      running.background = false;
      return running.database;
    }
    if (running && !running.background) throw new Error(`本机库 ${name} 已经开着：先关掉，或用开着的那份`);
    if (running) {
      this.#opened.delete(name);
      running.database.close().catch(report);
    }
    const database = create();
    this.#opened.set(name, { database, owner, background: false });
    return database;
  }

  /** 一份库关了（关库一调用就算，不等关完）：不再算开着 */
  closed(name: string, database: D) {
    if (this.#opened.get(name)?.database === database) this.#opened.delete(name);
  }

  /** 后台任务同步一次：开着就用开着的那份、不关；没开就开一份，同步完（出错也是）关掉，同步期间被前台接管了就不关 */
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
