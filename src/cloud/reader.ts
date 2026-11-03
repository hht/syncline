import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { readRows } from '../common/limits.ts';
import type { Cookie, Op, PullRange } from '../common/protocol.ts';
import type { Query } from '../common/storage.ts';
import { TableReads } from './batches.ts';
import type { Commits } from './commits.ts';
import { scopeOf } from './evolution.ts';
import { encodePosition, landedAt, type Position, rangesOf, recognize } from './position.ts';
import { type Budget, Step, type Visible } from './read-step.ts';

/**
 * 读取器：从一个位置往后读一块，私有与共用两种空间同一套。一轮里先扫描、后追尾巴：扫描集是这一轮的起点之后、水位及之前进入同步（含加列、
 * 共用空间改了可见范围）、现在仍在同步的表（整份的第一轮是水位时在同步的全部表），按表名、主键扫，每张先清掉再给当前看得见的行；
 * 增量的第一轮另把设备要求重下的表并进来，只清、只扫要求的那一段主键（按范围重下，校验和对不上之后）；尾巴从追到的一版追到最新，
 * 跳过扫描集里的表在它进入的那一版及之前的项（扫描已给了当前值）；追到最新时又有表进入，就开下一轮，水位换成最新一版。
 * 每次读过的行（含跳过的提交与项）与给出的字符到了预算就停，0 行也前进。位置随 cursor 往返，云端不记；位置里的各版不在当前历史上
 * （时间点恢复回滚过、截日志截过了、共用空间清空重建过）就认不出，由调用方定从头整份还是让设备重置。
 * 共用空间的设备只看得见订阅里的桶（Visible）：扫描一个桶一个桶地扫（一行在几个桶里就给几次，都是当前值），读当前值只给看得见的、看不见了给删除，
 * 尾巴只给改前或改后在订阅里的项；增量的第一轮另扫订阅里新加的桶（不清这张表）。
 * 照 model/Private.tla 的 HandlePull 与 FinalRows、Shared.tla 的 Chunks。
 * 不该知道的：块怎么回给设备（cursor 之外的字段、各客户端处理到第几条、扣下的写）、通知。
 */

/** 读出的一块：ops 是这一块的改动，共 chars 个字符；next 是接着读的位置（没有就是读到了最新，at 是这时的最新一版） */
export type Read = { ops: Op[]; chars: number } & ({ next: string } | { at: Cookie });

/**
 * 从哪读起：position 是位置，fresh 是这次新起的（整份的新起要先清空），carried 是上一块随 cursor 带来的；
 * head 是起计划时已读过的最新一版（同一次同步的调用里不会有新提交，读的时候不再读一遍）
 */
export type Begun = { position: Position; fresh: boolean; carried?: unknown; head?: Cookie };

export class Reader {
  readonly #query: Query;
  readonly #commits: Commits;
  /** 同步表怎么读：扫描、读当前值，校验和也用它 */
  readonly tables: TableReads;

  constructor(query: Query, tables: SQLiteTable[], commits: Commits) {
    this.#query = query;
    this.#commits = commits;
    this.tables = new TableReads(query, tables);
  }

  /**
   * 导出者（另一个消费者）读一块，至多 limit 个字符的改动：position 是它存着的位置（上一块的 next），认得出就接着读，没有或认不出（不在当前历史上）
   * 就从头整份；都带上 seen，接着读的途中时间点恢复回滚过就认不出。next 是读完这块的位置，追到了最新一版（done）时落在这一版（landedAt）
   */
  poll(position: string | undefined, limit: number): { ops: Op[]; next: string; done: boolean } {
    const head = this.#commits.head();
    const resumed = position === undefined ? undefined : this.resume(position);
    const begun = resumed
      ? { position: { ...resumed, seen: resumed.seen ?? head }, fresh: false, head }
      : { position: { ...this.start(null, head), seen: head }, fresh: true, head };
    const read = this.read(begun, { rows: readRows, chars: limit });
    return 'next' in read ? { ops: read.ops, next: read.next, done: false } : { ops: read.ops, next: landedAt(read.at), done: true };
  }

  /**
   * 新起一个计划：from 是增量的起点（整份是 null，先清空），水位 to 是这一轮扫到哪一版进入的表（起点与最新之间任一版：私有空间取最新一版，
   * 共用空间取最近的块边界，同一段时间里起拉的设备落在同一串网址上），尾巴从起点（整份从水位）追起；ranges 是要求重下的范围
   */
  start(from: Cookie | null, to: Cookie, ranges: PullRange[] = []): Position {
    return {
      full: from === null,
      round: { from, to },
      scan: { table: '' },
      ...(ranges.length > 0 && { ranges: rangesOf(ranges, (table) => this.tables.key(table)) }),
      tail: { at: from ?? to },
    };
  }

  /** 带回的 cursor 认不认得出（recognize，照当前历史与同步表的主键）；认不出是 undefined */
  resume(text: string): Position | undefined {
    return recognize(text, { onHistory: (cookie) => this.#commits.onHistory(cookie), key: (table) => this.tables.key(table) });
  }

  /**
   * 从 position 读一块：fresh 是这次新起的计划，整份的先清空；visible 是设备看得见哪些行（共用空间给）。还要接着读时，carry 由这一块
   * （改动的字符数、扫描给出的行数、是否以整份开头、尾巴追到的一版、上一块随 cursor 带来的）算出要随 next 带着的，下一块原样交回
   */
  read(
    { position, fresh, carried, head = this.#commits.head() }: Begun,
    budget: Budget,
    {
      visible,
      carry,
    }: {
      visible?: Visible;
      carry?: (read: { chars: number; scanned: number; full: boolean; at: Cookie; carried: unknown }) => unknown;
    } = {},
  ): Read {
    const ops: Op[] = fresh && position.full ? [{ op: 'clear' }] : [];
    const entered = scopeOf(
      this.#query,
      this.tables.order().map(({ table }) => table),
    );
    const step = new Step({ tables: this.tables, commits: this.#commits, entered }, { position, head, budget, ops, visible });
    const done = step.run();
    const { position: at, chars, scanned } = step;
    if (done) return { ops, chars, at: head };
    const carrying = carry?.({ chars, scanned, full: at.full, at: at.tail.at, carried });
    // 带着 seen 的（私有空间）换成这时的最新一版
    const next = encodePosition({ ...at, ...(at.seen && { seen: head }), ...(carrying === undefined ? {} : { carried: carrying }) });
    return { ops, chars, next };
  }
}
