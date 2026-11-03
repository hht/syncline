import type { Op } from '../common/protocol.ts';
import { utf8Bytes } from '../common/size.ts';
import { rowId } from '../tables/keys.ts';

// 一次推送或服务端写之后，给在线设备的通知里放什么：写的时候记下改到的每一行写完后的值（校验时已读过），
// 拼通知时不再回表读。同一行改了几次只给最后的值；装不下 limit 字节（改动的 JSON，UTF-8）就不再记、只发版本与确认，
// 设备收到提示走 HTTP 拉取。每次提交（一个事务）先记在一边，事务提交了才算数：回滚了的一行也不留。
// 不该知道的：写怎么执行与记、落后的设备怎么补

/** 一行的改动：写完后还在就是 put，不在了是 del */
type RowOp = Extract<Op, { op: 'put' | 'del' }>;

/** 报出改到的一行写完后的值（不在了是 undefined） */
export type Touched = (table: string, key: Record<string, unknown>, row: Record<string, unknown> | undefined) => void;

export class WrittenRows {
  readonly #limit: number;
  /** 行的标识 → 写完后的改动；undefined 是装不下了 */
  #ops: Map<string, RowOp> | undefined = new Map();
  #bytes = 0;

  /** limit 是通知至多多少字节；0 是不要通知（没有在线设备），什么也不记 */
  constructor(limit: number) {
    this.#limit = limit;
    if (limit === 0) this.#ops = undefined;
  }

  /**
   * 一次提交里记下改到的行：commit 在事务里执行，报出每一行写完后的值（不在了是 undefined）；commit 抛错就什么也不记、照样抛。
   * 边记边量：这次加上已有的超过 limit 就丢掉，不把一次大写的每一行都攒在内存里
   */
  record<T>(commit: (touched: Touched) => T): T {
    let touched: RowOp[] | undefined = this.#ops && [];
    let bytes = this.#bytes;
    const result = commit((table, key, row) => {
      if (!touched) return;
      const op: RowOp = row ? { op: 'put', table, key, row } : { op: 'del', table, key };
      bytes += utf8Bytes(JSON.stringify(op));
      if (bytes > this.#limit) touched = undefined;
      else touched.push(op);
    });
    if (!touched) this.#ops = undefined;
    else for (const op of touched) this.#add(op);
    return result;
  }

  /** 记下一行：同一行只留最后的值，装不下 limit 就不再记 */
  #add(op: RowOp) {
    if (!this.#ops) return;
    const id = rowId(op.table, op.key);
    const before = this.#ops.get(id);
    this.#bytes += utf8Bytes(JSON.stringify(op)) - (before ? utf8Bytes(JSON.stringify(before)) : 0);
    this.#ops.set(id, op);
    if (this.#bytes > this.#limit) this.#ops = undefined;
  }

  /** 通知的改动；装不下或不要通知是 undefined */
  ops(): Op[] | undefined {
    return this.#ops && [...this.#ops.values()];
  }
}
