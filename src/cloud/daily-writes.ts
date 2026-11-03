import type { Cursor } from '../common/storage.ts';
import type { Used } from './commits.ts';

/** 一天多少毫秒：按 UTC 的日子算 */
const dayMs = 86_400_000;

/**
 * 设备推来的写当天（UTC）写了几行怎么计、怎么存：按执行完的每条语句的 rowsWritten（计费用的值，含索引）计，所在事务之后回滚（扣下）也照算；
 * 服务端的写与 Syncline 自己排导出的写不算。每条写记上到它为止的行数，存在它的提交记录上，与写同一个事务、不为计数多写一行；
 * 对象休眠或重启后从最近记下的接着算。
 * 不该知道的：上限是多少、到了怎么办。
 * @see https://developers.cloudflare.com/durable-objects/platform/pricing/
 */
export class DailyWrites {
  /** 提交记录上最近记下的；还没有是 undefined */
  readonly #recorded: () => Used | undefined;
  /** 最近记下的；对象醒来后第一次用时从提交记录读 */
  #used: Used | undefined;
  #written = 0;

  constructor(recorded: () => Used | undefined) {
    this.#recorded = recorded;
  }

  /** 取出一条语句的全部行，加上它写了几行（游标取完之后才是计费用的值） */
  count(cursor: Cursor) {
    const rows = cursor.toArray();
    this.#written += cursor.rowsWritten ?? 0;
    return rows;
  }

  /** 对象到现在执行的 SQL 共写了几行（推送按它限一批的工作量） */
  get written() {
    return this.#written;
  }

  /** 当天到现在写了几行 */
  today(): Used {
    const day = Math.floor(Date.now() / dayMs);
    this.#used ??= this.#recorded() ?? { day, rows: 0 };
    return this.#used.day === day ? this.#used : { day, rows: 0 };
  }

  /** 量一条写：run 执行它，拿到的 used 给出当天到此刻写了几行（记进提交记录）；执行完（出错也是）记下 */
  measure<T>(run: (used: () => Used) => T): T {
    const { day, rows } = this.today();
    const start = this.#written;
    const used = () => ({ day, rows: rows + this.#written - start });
    try {
      return run(used);
    } finally {
      this.#used = used();
    }
  }
}
