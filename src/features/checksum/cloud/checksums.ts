import type { TableReads } from '../../../cloud/batches.ts';
import { decodeScan, encodeScan, type Scan } from '../../../cloud/position.ts';
import type { Checksum, ChecksumPart, Value } from '../../../common/protocol.ts';
import { fingerprintOf } from '../../../tables/fingerprint.ts';
import { plus, rangeRows, rowText } from '../common/checksum.ts';

/**
 * Computes checksums for private spaces: computed on demand when the device requests (pull includes checksum),
 * reading synced tables and device-visible columns from cursor in full-scan order (table name, primary key).
 * Adds the hashes of each row, up to rangeRows rows (or fewer if requested by the device), roughly rangeChars
 * characters, and rangeParts tables per segment. Returns the parts in the segment (primary key ranges per table),
 * row count, sum, and next segment start position. The device computes its local segment across the same primary
 * key range to compare; the final segment includes all synced tables so the device can detect leftover rows in
 * other tables.
 * Each segment fits within the CPU budget of a single request regardless of table size; computed on the fly without
 * logging during commits, evaluated against the current sync scope without extra maintenance when sync scopes change.
 * What it shouldn't know: how rows are written, how commits are logged, how often devices request.
 * @see https://docs.powersync.com/architecture/powersync-protocol
 */

/** Approximate character cap for a segment (row hash text): rows can approach the single-value limit, so segment size is capped by character count in addition to row count. */
const rangeChars = 8_000_000;

/** Maximum tables per segment: each table is an entry in the response; on mismatch, the device places the parts into a refetch pull request, keeping responses and refetch requests bounded regardless of table count. */
const rangeParts = 100;

/**
 * Computes a checksum segment starting at cursor, up to limit rows (capped at rangeRows).
 * The cursor is next returned from the previous segment: the reader scan position,
 * continuing in full-scan order (table name, primary key). Continues across table additions
 * or removals across deployments; if the starting table is no longer synced, resumes from the next
 * table name; empty string (from start) or unrecognized cursors start from the first table.
 */
export function spaceChecksum(tables: Pick<TableReads, 'order' | 'rows' | 'key'>, cursor: string, limit = rangeRows): Checksum {
  const order = tables.order();
  const most = Math.min(limit, rangeRows);
  const parts: ChecksumPart[] = [];
  let sum = 0;
  let rows = 0;
  let chars = 0;
  for (const { table, key, after } of startingAt(
    order,
    decodeScan(cursor, (table) => tables.key(table)),
  )) {
    // Table limit reached: next segment starts at this table.
    if (parts.length === rangeParts) return { parts, sum, rows, next: encodeScan({ table }) };
    const part: ChecksumPart = { table, key, ...(after && { after: after as Record<string, Value> }) };
    parts.push(part);
    for (const { rows: batch } of tables.rows(table, after))
      for (const row of batch) {
        const text = rowText(table, row.row);
        sum = plus(sum, fingerprintOf(text));
        rows += 1;
        chars += text.length;
        if (rows < most && chars < rangeChars) continue;
        part.until = row.key as Record<string, Value>;
        return { parts, sum, rows, next: encodeScan({ table, after: row.key }) };
      }
  }
  return { parts, sum, rows, tables: order.map(({ table }) => table) };
}

/** Tables to read starting from scan point start, along with their key offsets: skips tables before start, reads start table after its primary key; without a start point, returns all tables. */
const startingAt = (order: { table: string; key: string[] }[], start: Scan | undefined) =>
  order
    .filter(({ table }) => !start || table >= start.table)
    .map((entry) => ({ ...entry, after: entry.table === start?.table ? start.after : undefined }));
