import { fingerprintOf } from '../../../tables/fingerprint.ts';

/**
 * Checksum of rows in a space: sum of row hashes (modulo 2^32).
 * Segmented in full-scan order; cloud computes a segment on demand, device computes the corresponding
 * local segment and verifies: mismatch indicates a bug or storage corruption causing divergence, catching
 * issues missed by tests.
 * A row hash evaluates device-visible values: table name and non-null columns serialized as sorted-column
 * JSON under FNV-1a; null columns are omitted, matching newly added columns across schema version differences.
 * What it shouldn't know: where rows are read from, what to do upon mismatch.
 * @see https://docs.powersync.com/architecture/powersync-protocol
 */

/**
 * Maximum rows per segment (or fewer if requested by the device): 1 million 2-column rows take roughly
 * 3.6s and 9-column rows roughly 7s CPU on Cloudflare; 20,000 rows complete in under 0.2s.
 */
export const rangeRows = 20_000;

export const rowHash = (table: string, row: Record<string, unknown>) => fingerprintOf(rowText(table, row));

/** Serialized text of a row used for hashing: table name and non-null columns as column-name sorted JSON. */
export function rowText(table: string, row: Record<string, unknown>) {
  const values = Object.keys(row)
    .filter((column) => row[column] !== null && row[column] !== undefined)
    .sort()
    .map((column) => [column, row[column]]);
  return JSON.stringify([table, values]);
}

export const plus = (sum: number, hash: number) => (sum + hash) >>> 0;

/** Sum of row hashes. */
export const checksumOf = (hashes: Iterable<number>) => [...hashes].reduce(plus, 0);
