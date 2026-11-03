import type { Cookie, Progress } from '../common/protocol.ts';
import type { Commits } from './commits.ts';

// How private space download progress is estimated (following PowerSync downloadProgress with downloaded and total):
// full pulls estimate progress by sent op characters ÷ (database size − commit log bytes);
// incremental pulls estimate progress by walked commit bytes ÷ total commit bytes since cookie;
// each chunk executes bounded primary-key lookups independent of row counts or history length (without counting rows).
// Emits ratios: units vary by download kind (JSON characters for full pulls, commit log bytes for incremental);
// database size includes indexes and internal tables, while table scans for entering tables in incremental pulls are omitted from total;
// when downloaded exceeds total, total expands to match.
// What this module should not know: how changes are read or how chunks are constructed.

/** Computes progress after reading a chunk: `from` is incremental start (null for full pulls), `at` is the tail commit, `sent` is op characters in this chunk; `before` is carried from the previous cursor (undefined on first chunk, where total is initialized). */
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
