import { sharedWriteRows, writeRows } from '../common/limits.ts';
import type { Cookie } from '../common/protocol.ts';
import type { CloudStorage, Query } from '../common/storage.ts';
import { canonicalKey } from '../tables/keys.ts';
import { type Changed, limitRows, type Rows } from '../tables/rows.ts';
import type { Validator } from '../tables/validation.ts';
import type { BucketRows } from './bucket-rows.ts';
import type { Buckets } from './buckets.ts';
import { type Commits, changedRows, type Used } from './commits.ts';
import { withBuckets } from './shared.ts';
import type { Touched } from './written-rows.ts';

/**
 * 一次写怎么落成下一版的提交：在一个事务里写、记下改到的行、校验，共用空间再维护每一项在的桶与各桶的行数，出错整条回滚。
 * 不该知道的：写是谁的（设备推来的、服务端的、重新提交的）、执行不了时怎么办、怎么通知设备。
 */

/** 一个空间提交写要用到的：存储、提交记录、行怎么写、怎么校验；共用空间另有桶规则与各桶的行数 */
export type CommitContext = {
  storage: CloudStorage;
  commits: Commits;
  query: Query;
  rows: Rows;
  validator: Validator;
  buckets: Buckets | undefined;
  bucketRows: BucketRows | undefined;
};

/**
 * 在一个事务里写、校验、记成下一版的提交，出错整条回滚。改到的行边写边记，内存里只留一段；
 * 写完逐段校验改到的行（parents 时也查它引用的行还在不在：服务端的写在写完之后查），共用空间给每一项并上改后它在的桶
 * （改前的随这一项报出，见 Space.mutate），各桶的行数跟着增减。used 给出设备的写当天到此刻写了几行；touched 收下校验时读到的每一行写完后的值（拼通知用）。
 * 返回这次之后的最新一版：记了就是记下的最后一版，服务端的写没改到同步的行、没有记就是原来的最新一版
 */
export function commitWrite(
  { storage, commits, query, rows, validator, buckets, bucketRows }: CommitContext,
  client: string | null,
  id: number | null,
  write: (changed: Changed) => void,
  { parents = false, used, touched }: { parents?: boolean; used?: () => Used; touched?: Touched } = {},
): Cookie {
  const tally = bucketRows?.tally();
  return storage.transactionSync(() => {
    const recording = commits.begin(client, id, { used, reserve: buckets?.reserve ?? 0 });
    let count = 0;
    // 改到的行超过一次写的上限（连带删的也算；共用空间每行要维护桶，上限另算）就抛 Reject：设备的写扣下，服务端的写抛给调用方
    write(
      limitRows(buckets ? sharedWriteRows : writeRows, (table, key, before) => {
        count += 1;
        const canonical = canonicalKey(key);
        recording.add(before ? [table, canonical, before] : [table, canonical]);
      }),
    );
    // 设备的写都记（推进序号，扣下的也是）；服务端的写没改到同步的行就不记，不多一版、不发通知（一项也没加，库里什么也没写）
    if (client === null && count === 0) return commits.head();
    const head = recording.finish((keys) => {
      for (const [table, key] of changedRows(keys)) {
        const stored = validator.check(query, table, key);
        if (stored && parents) rows.checkParents(query, table, stored);
        touched?.(table, key, stored);
      }
      return buckets && tally ? withBuckets(buckets, query, keys, tally) : keys;
    });
    tally?.flush();
    return head;
  });
}
