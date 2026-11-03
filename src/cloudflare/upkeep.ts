import type { Events } from '../cloud/events.ts';
import { dropRetired, nextDrop } from '../cloud/evolution.ts';
import type { Query } from '../common/storage.ts';
import { type Chore, reserved, type Schedule } from './schedule.ts';

/**
 * 云端的对象在后台收拾的事：给已有的表补还缺的外键索引与桶规则的索引、删过时的桶规则的索引（defineTables 留下的），物理删过了宽限期的
 * 删掉的同步表。两样的工作量都随表的大小涨，放在打开对象时做，大到超出一次请求的 CPU 这个空间就打不开；
 * 打开时只登记，每次 alarm 只做一步（建一个索引或删一张表），出错按退避重排。一步本身仍要在一次调用的 CPU 之内。
 * 日志超了上限（写了之后、打开时查）就截日志，每次 alarm 截一步，截到上限的 3/4 为止。
 * 共用空间另有一件：每个桶的行数还有要数的、要删的（打开时查：规则改了、表进入同步才有），每次 alarm 做一步。
 * 不该知道的：哪些表该删、哪些索引该建。
 */

/** 在定时表里登记的名字 */
const name = `${reserved}upkeep`;
const truncateName = `${reserved}truncate`;
const countName = `${reserved}count`;

/** 提交记录：超没超上限、截一步（返回还要不要接着截） */
type Truncation = { commitsOverLimit(): boolean; truncate(): boolean };
/** 每个桶的行数：还有没有要做的、做一步（返回还有没有要做的） */
type Counting = { pending(): boolean; step(): boolean };

const retry = { base: 60_000, max: 3_600_000 };

export class Upkeep {
  readonly #query: Query;
  readonly #indexes: string[];
  readonly #keep: string[];
  readonly #timetable: Schedule;
  readonly #events: Events;
  readonly #truncation: Truncation | undefined;
  readonly #counting: Counting | undefined;
  /** 这一步做的是哪样：出错时报出 */
  #step: 'index' | 'drop' = 'index';

  /**
   * indexes 是建还缺的、删过时的索引的语句；keep 是只在云端用的表（删掉的同步表过了宽限期，仍在这里的不删）；出错报给 events；
   * truncation 截提交记录，counting 数每个桶的行数（共用空间）。打开对象时构造，有要做的就登记
   */
  constructor(
    query: Query,
    indexes: string[],
    keep: string[],
    timetable: Schedule,
    events: Events,
    { truncation, counting }: { truncation?: Truncation; counting?: Counting | undefined } = {},
  ) {
    this.#query = query;
    this.#indexes = [...indexes];
    this.#keep = keep;
    this.#timetable = timetable;
    this.#events = events;
    this.#truncation = truncation;
    this.#counting = counting;
    this.written();
    if (counting?.pending()) timetable.by(countName, Date.now());
    const at = indexes.length > 0 ? Date.now() : nextDrop(query, keep)?.at;
    if (at !== undefined) timetable.by(name, at);
  }

  /** 有了新的一版：日志超了上限就登记截日志（在退避中的不提前） */
  written() {
    if (this.#truncation?.commitsOverLimit()) this.#timetable.by(truncateName, Date.now());
  }

  /** 定时表里登记的一件是不是这里的事：是就给出它，不是是 undefined */
  chore(registered: string): Chore | undefined {
    const truncation = this.#truncation;
    if (registered === truncateName && truncation) return this.#chore('truncate', () => truncation.truncate());
    const counting = this.#counting;
    if (registered === countName && counting) return this.#chore('count', () => counting.step());
    if (registered !== name) return undefined;
    return {
      run: async () => this.#run(),
      retry,
      failed: (error) =>
        this.#events({ type: 'upkeep.failed', step: this.#step, reason: error instanceof Error ? error.message : String(error) }),
    };
  }

  /** 一件一步一步做的事：run 做一步、返回还要不要接着做，出错按 step 报出 */
  #chore(step: 'truncate' | 'count', run: () => boolean): Chore {
    return {
      run: async () => run(),
      retry,
      failed: (error) => this.#events({ type: 'upkeep.failed', step, reason: error instanceof Error ? error.message : String(error) }),
    };
  }

  /** 做一步：先补索引，再删到时候了的表；返回还有没有马上要做的，删表还没到时候的照它的时刻登记 */
  #run() {
    const [index] = this.#indexes;
    if (index !== undefined) {
      this.#step = 'index';
      this.#query(index);
      this.#indexes.shift();
      if (this.#indexes.length > 0) return true;
    } else {
      this.#step = 'drop';
      dropRetired(this.#query, this.#keep);
    }
    const next = nextDrop(this.#query, this.#keep)?.at;
    if (next !== undefined) this.#timetable.by(name, next);
    return false;
  }
}
