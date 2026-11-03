import { readRows } from '../common/limits.ts';
import { isProgress } from '../common/parse.ts';
import type { Checksum, Chunk, Poke, Progress } from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import type { TableReads } from './batches.ts';
import type { Commits } from './commits.ts';
import { type HeldWrites, heldIn } from './held.ts';
import { progressAfter } from './progress.ts';
import type { Begun, Reader } from './reader.ts';

/**
 * 私有空间怎么给块：从哪读起在这里定（没有游标、游标或 cursor 认不出就整份，否则增量，分块中途接着读），读到哪由读取器定，
 * 这里拼成回给设备的块。每块给的都是读时的当前值、后面的块覆盖前面的，设备暂存到末块一起生效，就等于末块那一版的云端；
 * 从头重拉时游标与待上传都不动。末块带各客户端处理到第几条（HTTP 拉取给设备列出的，连上时的补齐给游标之后有提交的），设备据此丢掉已处理的。
 * 一块至多读 readRows 行、给 limit 个字符的改动（JSON，opChars）。
 * 不该知道的：改动怎么读、写怎么执行与记、共用空间的块。
 */

/** 从 cursor 起当场算的一段校验和（可插拔的功能，组装根给校验和功能的 spaceChecksum） */
export type SpaceChecksum = (tables: TableReads, cursor: string, rows: number | undefined) => Checksum;

/**
 * 给出的块报给谁，末块带上哪些扣下的写（列出的客户端从各自最早的待上传起的，或某版之后的）、从 cursor 起当场算的一段校验和（没装校验和的不给），
 * 库文件多大（下载进度用）
 */
type Report = {
  databaseSize: () => number;
  pulled: <T extends Poke | Chunk>(chunk: T, chars: number) => T;
  held: Pick<HeldWrites, 'from' | 'since'>;
  checksum?: ((cursor: string, rows: number | undefined) => Checksum) | undefined;
};

/**
 * 从哪读起：cursor 是上一块的 next，认得出、带着 seen（读到一半时间点恢复回滚过就认不出）、增量的游标也在当前历史上
 * 就接着读，否则从头整份；没有 cursor 就从游标起，游标为空、不在当前历史上或要求整份（refetch）就整份，否则增量，第一轮并进要求重下的范围（ranges）
 */
function begin(commits: Commits, reader: Reader, { cookie, cursor, refetch, ranges = [] }: PullRequest): Begun {
  const resumed = cursor === undefined ? undefined : reader.resume(cursor);
  if (resumed?.seen !== undefined && (resumed.full || (cookie !== null && commits.onHistory(cookie))))
    return { position: resumed, fresh: false, carried: resumed.carried };
  const full = cookie === null || refetch === true || cursor !== undefined || !commits.onHistory(cookie);
  const head = commits.head();
  return { position: { ...reader.start(full ? null : cookie, head, full ? [] : ranges), seen: head }, fresh: true, head };
}

/** 拉一块；catchUp 是连上时的补齐（不列客户端，见末块） */
export function pull(commits: Commits, reader: Reader, request: PullRequest, limit: number, report: Report, catchUp = false): Poke | Chunk {
  const { cookie, cursor } = request;
  const basisOf = (full: boolean) => (full ? null : cookie);
  // 下载进度随 cursor 带着：总共第一次分块时算，一块拉完的不算
  let progressed: Progress | undefined;
  const read = reader.read(
    begin(commits, reader, request),
    { rows: readRows, chars: limit },
    {
      carry: ({ chars, full, at, carried }) => {
        const before = isProgress(carried) ? carried : undefined;
        progressed = progressAfter(commits, { from: basisOf(full), at, sent: chars, databaseSize: report.databaseSize() }, before);
        return progressed;
      },
    },
  );
  const continued = cursor === undefined ? {} : { cursor };
  if ('next' in read)
    return report.pulled(
      { base: cookie, ...continued, next: read.next, patch: read.ops, ...(progressed && { progress: progressed }) },
      read.chars,
    );
  // HTTP 拉取只带请求列出的客户端（设备待上传的与当前的）处理到第几条：整份落地时设备据此丢掉已处理的，按客户端表的主键查、不随提交记录涨。
  // 扣下的写只给列出的客户端从各自最早的待上传起的（没有待上传的当前客户端从它下一条写起）：设备只认它这次确认的写里扣下的，别的给了也用不上。
  // 连上时的补齐是增量（游标在当前历史上才补齐）：带游标之后有提交的客户端（模型的 LmidsSince）与这段里扣下的，都不多于这段读过的提交
  const since = catchUp ? (cookie?.version ?? 0) : undefined;
  const lmids = since === undefined ? commits.lmidsOf(request.clients ?? []) : commits.lmidsSince(since);
  const checksum = request.checksum !== undefined &&
    report.checksum && { checksum: report.checksum(request.checksum, request.checksumRows) };
  return report.pulled(
    {
      base: cookie,
      ...continued,
      cookie: read.at,
      lmids,
      patch: read.ops,
      ...heldIn(since === undefined ? report.held.from(request.earliest ?? {}) : report.held.since(since)),
      ...checksum,
    },
    read.chars,
  );
}
