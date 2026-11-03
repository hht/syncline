import { readBytes, valueChars } from '../common/limits.ts';
import type { Poke } from '../common/protocol.ts';
import type { Query } from '../common/storage.ts';
import { within } from './batches.ts';

/**
 * 云端扣下的写（待修复）怎么存：设备推来的写执行不了（拒收，或每次执行都会出的错），照样推进这个客户端的序号、不再重发
 * （否则这个客户端之后的写全被挡住），原样的改动与原因存在这里：能追溯，修好数据或代码后重新提交，数据不丢。
 * 改动按 valueChars 个码元分几行存：一行要在单个值的上限之内，不切开代理对（切开的两半存进 SQLite 各成 U+FFFD）。
 * 都在调用方开好的事务里执行。
 * 不该知道的：写怎么执行。
 * @see https://doc.replicache.dev/reference/server-push（Error Handling）
 */

/** 扣下的一条写：哪个客户端的第几条、为什么（通知与末块里的样子） */
export type Held = NonNullable<Poke['held']>[number];

/** 扣下的写放进通知与末块（没有就不带），设备据此告诉用户哪条没存上 */
export const heldIn = (held: Held[]) => (held.length > 0 ? { held } : {});

export class HeldWrites {
  readonly #query: Query;

  constructor(query: Query) {
    this.#query = query;
  }

  /** 扣下一条写：version 是记下它的那次（不改行的）提交；changes 是推来的原样的改动，可以是认不出的 */
  add(version: number, { client, id, reason }: Held, changes: unknown) {
    const text = JSON.stringify(changes);
    const at = Date.now();
    for (let part = 0, start = 0; part === 0 || start < text.length; part += 1) {
      let end = Math.min(text.length, start + valueChars);
      // 不切在代理对中间：结尾是高位代理就往回退一个
      if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
      this.#query('INSERT INTO _syncline_held VALUES (?, ?, ?, ?, ?, ?, ?)', client, id, part, version, reason, at, text.slice(start, end));
      start = end;
    }
  }

  /** 版本 version 之后扣下的写（推送的通知带这批里扣下的，连上时的补齐带游标之后扣下的） */
  since(version: number): Held[] {
    return this.#parsed(
      this.#query('SELECT client, mutation_id, reason FROM _syncline_held WHERE part = 0 AND version > ? ORDER BY version', version),
    );
  }

  /**
   * 这几个客户端从各自最早的待上传起扣下的写（拉取的末块带：设备只用得到这次确认的写里扣下的）：按主键（client, mutation_id）取，
   * 读的只是这一段，不随别的扣下的多少涨。这一段里已执行的只有确认还没到设备的，至多是在路上的一批推送；
   * 从旧备份恢复、克隆出的库还列着旧客户端时例外，读到原设备之后以它扣下的，确认之后就不再列它
   */
  from(earliest: Record<string, number>): Held[] {
    if (Object.keys(earliest).length === 0) return [];
    // CROSS JOIN 定下 json_each 在外层：每个客户端按主键往后找；让查询规划器选的话它会把扣下的写放在外层、整张扫
    // @see https://sqlite.org/optoverview.html#crossjoin
    return this.#parsed(
      this.#query(
        `SELECT h.client, h.mutation_id, h.reason FROM json_each(?) e CROSS JOIN _syncline_held h
           WHERE h.client = e.key AND h.mutation_id >= e.value AND h.part = 0 ORDER BY h.version`,
        JSON.stringify(earliest),
      ),
    );
  }

  #parsed(rows: Record<string, unknown>[]): Held[] {
    return rows.map((row) => ({ client: String(row.client), id: Number(row.mutation_id), reason: String(row.reason) }));
  }

  /**
   * 扣下的写，连同原样的改动（推来的样子，可以是认不出的）与扣下的时刻（毫秒），按扣下的先后；一次至多 limit 条、改动共约 readBytes 字节（一条可以有约 9 MiB：推来的一条写至多 writeBytes，认不出的原样扣下、至多一条推送的上限 pushBytes，
   * 先读各条的字节数再取正文，至少一条），after 是上一页最后一条记下它的版本，从它之后接着给
   */
  list({ limit = 100, after = 0 }: { limit?: number; after?: number } = {}) {
    const sizes = this.#query(
      'SELECT client, mutation_id, sum(octet_length(changes)) AS bytes FROM _syncline_held WHERE version > ? GROUP BY client, mutation_id ORDER BY min(version) LIMIT ?',
      after,
      limit,
    );
    return sizes.slice(0, within(sizes, readBytes)).map(({ client, mutation_id }) => this.#one(String(client), Number(mutation_id)));
  }

  has(client: string, id: number) {
    return this.#query('SELECT 1 FROM _syncline_held WHERE client = ? AND mutation_id = ? AND part = 0', client, id).length > 0;
  }

  /** 一条扣下的写；没有就抛错 */
  #one(client: string, id: number) {
    const parts = this.#query(
      'SELECT version, reason, at, changes FROM _syncline_held WHERE client = ? AND mutation_id = ? ORDER BY part',
      client,
      id,
    );
    const [first] = parts;
    if (!first) throw new Error(`没有扣下这条写：${client} 的第 ${id} 条`);
    const changes: unknown = JSON.parse(parts.map((part) => String(part.changes)).join(''));
    return { client, id, reason: String(first.reason), version: Number(first.version), at: Number(first.at), changes };
  }

  /** 取出一条扣下的写的原样改动（不删）：推来的样子，可以是认不出的 */
  changes(client: string, id: number) {
    return this.#one(client, id).changes;
  }

  remove(client: string, id: number) {
    this.#query('DELETE FROM _syncline_held WHERE client = ? AND mutation_id = ?', client, id);
  }
}
