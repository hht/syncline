import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { defaultShards, noticeBudget, reconnectRate } from '../cloud/broadcast.ts';
import { bucketBytes } from '../cloud/buckets.ts';
import { rowOverhead } from '../cloud/commits.ts';
import { defaultConnections } from '../cloud/server.ts';
import { defaultRows } from '../cloud/shared.ts';
import {
  commitFloor,
  keyBytes,
  pullBytes,
  pushBytes,
  readRows,
  sharedWriteRows,
  subscriptionBytes,
  truncateBytes,
  truncateRows,
  valueBytes,
  valueChars,
  writeBytes,
  writeKeyBytes,
  writeRows,
} from '../common/limits.ts';
import { chunkLimit, pushMutations, slowestRate, socketLimit } from '../common/protocol.ts';
import { receiveTimeout as shellReceiveTimeout } from '../expo/shell.ts';
import { rangeChars, rangeParts } from '../features/checksum/cloud/checksums.ts';
import { rangeRows } from '../features/checksum/common/checksum.ts';
import { defaultExportBudget, defaultExportDelay, maxExportDelay } from '../features/exports/cloud/exports.ts';
import { rustLimits } from './test-rust.ts';

// Documentation limits for integrators match code constants: each statement is computed dynamically from constants; modifying constants without updating documentation fails. Device-side values are read from the Rust core.

const { pushLimit, receiveTimeout, pingAfter, pongWithin, baseDelay, maxDelay, maxRowBytes, batch, rowsPerDay, interval, askAgainAfter } =
  rustLimits();

const limits = readFileSync(new URL('../../docs/reference/limits.md', import.meta.url), 'utf8');

const count = (value: number) => value.toLocaleString('en-US');
const seconds = (ms: number) => `${ms / 1000} ${ms === 1000 ? 'second' : 'seconds'}`;
const minutes = (ms: number) => `${ms / 60_000} ${ms === 60_000 ? 'minute' : 'minutes'}`;
const hours = (ms: number) => `${ms / 3_600_000} ${ms === 3_600_000 ? 'hour' : 'hours'}`;
const mib = (bytes: number) => `${bytes / 2 ** 20} MiB`;
const mb = (bytes: number) => `${bytes / 1_000_000} MB`;
const kb = (bytes: number) => `${bytes / 1000} KB`;

test.each([
  // Sizes
  `${mib(writeBytes)} (UTF-8)`,
  `exceeding ${mib(pushBytes)} (UTF-8)`,
  `pull request body exceeds ${mb(pullBytes)} (UTF-8)`,
  `Roughly ${count(pushLimit)} bytes of changes`,
  `up to ${count(pushMutations)} mutations`,
  `${count(defaultConnections)} concurrent connections`,
  `${count(socketLimit)} bytes per entire message`,
  `minimum transfer rate of ${kb(slowestRate)}/s`,
  `does not exceed ${count(noticeBudget)}`,
  `Roughly ${count(chunkLimit)} characters for private spaces`,
  `reads at most ${count(readRows)} rows from the database`,
  `every ${count(defaultRows)} modified rows by default (\`chunkRows\`)`,
  `${count(keyBytes)} bytes encoded as JSON`,
  `at most ${count(subscriptionBytes)} bytes encoded as JSON`,
  `at most ${count(bucketBytes)} bytes per bucket`,
  `Synced columns total ${count(maxRowBytes)} bytes (DO rows cap at ${mb(valueBytes)}`,
  `greater of roughly ${mib(commitFloor)} and`,
  `roughly ${count(rowOverhead)} bytes per version`,
  `deleting at most ${count(truncateRows)} commits and ${mib(truncateBytes)} of primary keys`,
  `default ${count(defaultShards)} shards`,
  `${count(writeRows)} rows (shared spaces support only server writes, up to ${count(sharedWriteRows)} rows: each row must also maintain its buckets), and primary keys total ${mb(writeKeyBytes)}`,
  `at most ${count(rangeRows)} rows, roughly ${count(rangeChars)} characters, and ${count(rangeParts)} tables`,
  `halves down to ${count(batch)} rows`,
  `requests at most ${count(rowsPerDay)} rows per day`,
  // Durations
  `no data is received for ${seconds(receiveTimeout)}`,
  `idle for ${seconds(pingAfter)}, and if no message arrives within ${seconds(pongWithin)}`,
  `min(${seconds(maxDelay)}, ${seconds(baseDelay)} * 2ⁿ)`,
  `${count(reconnectRate)} devices per second`,
  `${seconds(defaultExportDelay)} after a write (\`exportDelay\`)`,
  `up to ${hours(maxExportDelay)}`,
  `exports for at most ${minutes(defaultExportBudget)} per alarm (\`exportBudget\`)`,
])('limits.md states: %s', (sentence) => {
  expect(limits).toContain(sentence);
});

test('checksum verification waits a full day after completing a round, and retries failed sections at most once per minute', () => {
  expect([interval, askAgainAfter]).toEqual([24 * 3_600_000, 60_000]);
  expect(limits).toContain('a full day after the previous round completed');
  expect(limits).toContain('at most once per minute');
});

test('Rust device-side limits match cloud limits', () => {
  expect(rustLimits()).toMatchObject({ valueBytes, valueChars, keyBytes, writeRows, writeKeyBytes });
});

test('web shell determines HTTP pull stall from core duration (native shell imports core constants directly)', () => {
  expect(shellReceiveTimeout).toBe(receiveTimeout);
});
