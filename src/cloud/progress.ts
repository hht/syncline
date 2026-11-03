import type { Cookie, Progress } from '../common/protocol.ts';
import type { Commits } from './commits.ts';

// 私有空间的下载进度怎么估（照 PowerSync 的 downloadProgress 给已下与总共）：整份按已发改动的字符数 ÷（库文件多大 − 日志的字节），
// 增量按尾巴追过的日志字节 ÷ 游标之后的日志字节；每块只是几次按主键取的读，与表的行数、历史的长短无关（不数行）。
// 只给比例：单位随下载方式（整份是改动的 JSON 字符，增量是提交记录的字节）；库文件里还有索引与 Syncline 自己的表，增量里进入同步的表的扫描
// 不计进总共，都是估计，已下超过总共时总共跟着涨。
// 不该知道的：改动怎么读、块怎么拼

/** 这一块读完时的进度：from 是增量的起点（整份是 null），at 是尾巴追到的一版，sent 是这块改动的字符数（opChars）；before 是上一块随 cursor 带来的（第一块没有，这时算总共） */
export function progressAfter(
  commits: Commits,
  { from, at, sent, databaseSize }: { from: Cookie | null; at: Cookie; sent: number; databaseSize: number },
  before: Progress | undefined,
): Progress {
  if (from === null) {
    const downloaded = (before?.downloaded ?? 0) + sent;
    return { downloaded, total: Math.max(before?.total ?? databaseSize - commits.bytes(), downloaded) };
  }
  const start = commits.bytesAt(from.version);
  const downloaded = commits.bytesAt(at.version) - start;
  return { downloaded, total: Math.max(before?.total ?? commits.bytesAt(commits.head().version) - start, downloaded) };
}
