import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { defaultShards, reconnectRate } from '../cloud/broadcast.ts';
import { bucketBytes } from '../cloud/buckets.ts';
import { defaultConnections } from '../cloud/server.ts';
import { defaultRows } from '../cloud/shared.ts';
import {
  commitFloor,
  keyBytes,
  readRows,
  sharedWriteRows,
  subscriptionBytes,
  tableNameChars,
  valueBytes,
  valueChars,
  writeBytes,
  writeKeyBytes,
  writeRows,
} from '../common/limits.ts';
import { pushMutations, socketLimit } from '../common/protocol.ts';
import { receiveTimeout as shellReceiveTimeout } from '../expo/shell.ts';
import { defaultExportBudget, defaultExportDelay, maxExportDelay } from '../features/exports/cloud/exports.ts';
import { rustLimits } from './test-rust.ts';

// Documentation limits for integrators match code constants: each statement is computed dynamically from constants; modifying constants without updating documentation fails. Device-side values are read from the Rust core.

const { receiveTimeout, pingAfter, pongWithin, slowestRate, baseDelay, maxDelay, maxRowBytes, rowsPerDay, interval } = rustLimits();

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
  `${count(defaultConnections)} concurrent connections`,
  `fits in ${count(socketLimit)} bytes (UTF-8)`,
  `in steps of up to ${count(readRows)} rows`,
  `every ${count(defaultRows)} modified rows by default (\`chunkRows\`)`,
  `${count(keyBytes)} bytes encoded as JSON`,
  `table names hold at most ${count(tableNameChars)} characters`,
  `at most ${count(subscriptionBytes)} bytes encoded as JSON`,
  `at most ${count(bucketBytes)} bytes per bucket`,
  `Synced columns total ${count(maxRowBytes)} bytes (DO rows cap at ${mb(valueBytes)}`,
  `greater of roughly ${mib(commitFloor)} and`,
  `default ${count(defaultShards)} shards`,
  `${count(writeRows)} rows (shared spaces support only server writes, up to ${count(sharedWriteRows)} rows: each row must also maintain its buckets), and primary keys total ${mb(writeKeyBytes)}`,
  `requests at most ${count(rowsPerDay)} rows per day`,
  // Durations
  `no data is received for ${seconds(receiveTimeout)}`,
  `as long as its bytes take at ${kb(slowestRate)}/s`,
  `idle for ${seconds(pingAfter)}, and if no message arrives within ${seconds(pongWithin)}`,
  `min(${seconds(maxDelay)}, ${seconds(baseDelay)} * 2ⁿ)`,
  `${count(reconnectRate)} devices per second`,
  `${seconds(defaultExportDelay)} after a write (\`exportDelay\`)`,
  `up to ${hours(maxExportDelay)}`,
  `exports for at most ${minutes(defaultExportBudget)} per alarm (\`exportBudget\`)`,
])('limits.md states: %s', (sentence) => {
  expect(limits).toContain(sentence);
});

test('checksum verification waits a full day after completing a round', () => {
  expect(interval).toBe(24 * 3_600_000);
  expect(limits).toContain('a full day after the previous round completed');
});

test('Rust device-side limits match cloud limits', () => {
  expect(rustLimits()).toMatchObject({
    valueBytes,
    valueChars,
    keyBytes,
    writeRows,
    writeKeyBytes,
    writeBytes,
    pushMutations,
    socketLimit,
  });
});

test('web shell determines HTTP pull stall from core duration (native shell imports core constants directly)', () => {
  expect(shellReceiveTimeout).toBe(receiveTimeout);
});
