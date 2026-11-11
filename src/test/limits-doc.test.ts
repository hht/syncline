import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { defaultShards, reconnectRate } from '../cloud/broadcast.ts';
import { bucketBytes } from '../cloud/buckets.ts';
import { defaultConnections } from '../cloud/server.ts';
import { defaultRows } from '../cloud/shared.ts';
import {
  commitFloor,
  keyBytes,
  nameBytes,
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
  // Schema and writes
  `Table names hold at most ${count(tableNameChars)} characters.`,
  `takes at most ${count(keyBytes)} bytes encoded as JSON (UTF-8)`,
  `total at most ${count(maxRowBytes)} bytes.`,
  `a server write past Cloudflare's ${mb(valueBytes)} row limit fails`,
  `One local write holds at most ${mib(writeBytes)} (UTF-8).`,
  `One write changes at most ${count(writeRows)} rows.`,
  `total at most ${mb(writeKeyBytes)} encoded as JSON.`,
  `Shared spaces accept only server writes, up to ${count(sharedWriteRows)} rows each.`,
  `A private space accepts ${count(defaultConnections)} concurrent connections (\`connections\`).`,
  `that device waits a random time up to ${seconds(maxDelay)} before reconnecting.`,
  `| 1008 | Too many connections | Retries within ${seconds(maxDelay)} |`,
  // Downloads, storage, and shared spaces
  `requests at most ${count(rowsPerDay)} rows per day (\`checksumRowsPerDay\`)`,
  `the greater of roughly ${mib(commitFloor)} and 1/4 of the data`,
  `takes at most ${count(subscriptionBytes)} bytes encoded as JSON`,
  `at most ${count(bucketBytes)} bytes per bucket`,
  `(\`#${defaultShards - 1}\` with the default ${count(defaultShards)} shards), fits in ${count(nameBytes)} bytes (UTF-8)`,
  `spread over ${count(defaultShards)} broadcast shards by default (\`shards\`)`,
  // Cloudflare allows 10,000 subrequests per invocation by default, and a publish calls every shard.
  // @see https://developers.cloudflare.com/workers/platform/limits/#subrequests
  `One request can await about ${count(Math.floor(10_000 / defaultShards))} publishes`,
  `recorded every ${count(defaultRows)} modified rows by default (\`chunkRows\`)`,
  `in steps of up to ${count(readRows)} rows`,
  // Timing
  `when a message fits in ${count(socketLimit)} bytes (UTF-8)`,
  `If no data is received for ${seconds(receiveTimeout)}`,
  `idle for ${seconds(pingAfter)}, and if no message arrives within ${seconds(pongWithin)}`,
  `as long as its bytes take at ${kb(slowestRate)}/s`,
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

test('the Chinese translation states the same numbers as the English limits', () => {
  const translation = readFileSync(new URL('../../docs/reference/zh-CN/limits.md', import.meta.url), 'utf8');
  const numbers = (text: string) => (text.match(/\d+(?:[.,:/-]\d+)*/g) ?? []).sort();
  expect(numbers(translation)).toEqual(numbers(limits));
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
