import { readFileSync } from 'node:fs';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { defaultShards, reconnectRate } from '../cloud/broadcast.ts';
import { Buckets, bucketBytes, rulesPerTable } from '../cloud/buckets.ts';
import { defaultConnections } from '../cloud/server.ts';
import { defaultRows } from '../cloud/shared.ts';
import { Space } from '../cloud/space.ts';
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
import {
  expired,
  invalidPush,
  overQuota,
  pullNeeded,
  pushFailed,
  pushMutations,
  socketLimit,
  tooManyConnections,
  unsupportedMessage,
} from '../common/protocol.ts';
import { versionMismatch } from '../common/version.ts';
import { receiveTimeout as shellReceiveTimeout } from '../expo/shell.ts';
import { defaultExportBudget, defaultExportDelay, maxExportDelay } from '../features/exports/cloud/exports.ts';
import { schemaMismatch } from '../tables/declaration.ts';
import { rustLimits } from './test-rust.ts';
import { cloudStorage } from './test-storage.ts';

// Documentation limits for integrators match code constants: each statement is computed dynamically from constants; modifying constants without updating documentation fails. Device-side values are read from the Rust core.
// Every number the document writes in digits stands in such a statement, or in one listed as given by no constant of this repository.

const { receiveTimeout, pingAfter, pongWithin, slowestRate, baseDelay, maxDelay, maxRowBytes, rowsPerDay, interval } = rustLimits();

const limits = readFileSync(new URL('../../docs/reference/limits.md', import.meta.url), 'utf8');
const peers: Record<string, string> = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).peerDependencies;
/** A number as the document writes it, with its separators. */
const numbers = /\d+(?:[.,:/-]\d+)*/g;

const count = (value: number) => value.toLocaleString('en-US');
const seconds = (ms: number) => `${ms / 1000} ${ms === 1000 ? 'second' : 'seconds'}`;
const minutes = (ms: number) => `${ms / 60_000} ${ms === 60_000 ? 'minute' : 'minutes'}`;
const hours = (ms: number) => `${ms / 3_600_000} ${ms === 3_600_000 ? 'hour' : 'hours'}`;
const mib = (bytes: number) => `${bytes / 2 ** 20} MiB`;
const mb = (bytes: number) => `${bytes / 1_000_000} MB`;
const kb = (bytes: number) => `${bytes / 1000} KB`;
const thousands = (value: number) => count(Math.floor(value / 1000) * 1000);

const note = sqliteTable('note', { id: text().primaryKey() });

/** Row writes billed for one upload of `writes` writes changing `rows` rows each of a table without indexes, as the daily cap counts them. */
function billed(writes: number, rows: number) {
  const space = new Space(cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY)'), [note]);
  const changes = (write: number) =>
    Array.from({ length: rows }, (_, row) => ({ op: 'put' as const, table: 'note', row: { id: `${write}-${row}` } }));
  space.push(Array.from({ length: writes }, (_, write) => ({ client: 'c1', id: write + 1, changes: changes(write) })));
  return space.pushedToday();
}

/** Each index of a rule is one more row written per insert. */
const ruleIndexes = new Buckets([note], { rule: { note: { where: "id = 'a'" } } }).indexes('note').length;
// One bucket of a rule named `team` with a UUID parameter, as the subscription's JSON holds it, with its comma.
const bucketEntry = JSON.stringify(JSON.stringify(['team', crypto.randomUUID()])).length + 1;
// The cloud binds the pending clients of a pull, each with its earliest pending write, as one SQL value: "<client UUID>":1 and a comma each.
const clientEntry = JSON.stringify({ [crypto.randomUUID()]: 1 }).length - 1;

/**
 * Statements of the document tied to the code: computed from it, or for the last four held by other tests. Each claims its numbers
 * once: one the document makes twice is listed twice.
 */
const stated = [
  // Schema and writes
  `Table names hold at most ${count(tableNameChars)} characters.`,
  `takes at most ${count(keyBytes)} bytes encoded as JSON (UTF-8)`,
  `total at most ${count(maxRowBytes)} bytes.`,
  `a server write past Cloudflare's ${mb(valueBytes)} row limit fails`,
  `One local write holds at most ${mib(writeBytes)} (UTF-8).`,
  `One write changes at most ${count(writeRows)} rows.`,
  `total at most ${mb(writeKeyBytes)} encoded as JSON.`,
  `Shared spaces accept only server writes, up to ${count(sharedWriteRows)} rows each.`,
  `the cloud closes the connection with ${overQuota}.`,
  `A private space accepts ${count(defaultConnections)} concurrent connections (\`connections\`).`,
  `that device waits a random time up to ${seconds(maxDelay)} before reconnecting.`,
  // Downloads, storage, and shared spaces
  `closes its connection (${pullNeeded})`,
  `requests at most ${count(rowsPerDay)} rows per day (\`checksumRowsPerDay\`)`,
  `the greater of roughly ${mib(commitFloor)} and 1/4 of the data`,
  `takes at most ${count(subscriptionBytes)} bytes encoded as JSON`,
  `at most ${count(bucketBytes)} bytes per bucket`,
  `That is about ${Math.round(subscriptionBytes / bucketEntry / 10) * 10} buckets when rules have one UUID parameter.`,
  `(\`#${defaultShards - 1}\` with the default ${count(defaultShards)} shards), fits in ${count(nameBytes)} bytes (UTF-8)`,
  `spread over ${count(defaultShards)} broadcast shards by default (\`shards\`)`,
  // Cloudflare allows 10,000 subrequests per invocation by default, and a publish calls every shard.
  // @see https://developers.cloudflare.com/workers/platform/limits/#subrequests
  `One request can await about ${count(Math.floor(10_000 / defaultShards))} publishes`,
  `Each rule with a filter or bucket columns adds ${ruleIndexes} billed row write per insert`,
  `A table can belong to at most ${count(rulesPerTable)} rules.`,
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
  `back off up to ${hours(maxExportDelay)} on failure`,
  `exports for at most ${minutes(defaultExportBudget)} per alarm (\`exportBudget\`)`,
  // Things to know
  `An uploaded write is billed ${billed(1, 1) - 1} row writes besides the rows it changes`,
  `One \`write\` of 100 rows costs ${billed(1, 100)}; 100 writes of one row each cost ${billed(100, 1)}.`,
  // Connection errors
  `Except for ${pullNeeded}, ${versionMismatch}, and ${schemaMismatch}, the code shows`,
  `| ${pullNeeded} | The device must download first |`,
  `| ${expired} | Token expired |`,
  `| ${versionMismatch} | App and cloud versions differ |`,
  `| ${schemaMismatch} | App and cloud schemas differ |`,
  `| ${invalidPush} | Cloud rejected a batch of uploaded writes`,
  `| ${tooManyConnections} | Too many connections | Retries within ${seconds(maxDelay)} |`,
  `| ${pushFailed} | Cloud failed to store the upload |`,
  `| ${overQuota} | Upload quota reached |`,
  `| ${unsupportedMessage} | Binary message, or an upload to a shared space |`,
  // Requirements
  `\`drizzle-orm\` ${peers['drizzle-orm']}.`,
  // Edge cases
  `on about ${thousands(valueBytes / clientEntry)} launches without ever syncing`,
  `up to about ${(writeBytes / slowestRate / 3600).toFixed(1)} hours for one ${mib(writeBytes)} write`,
  `in a bucket over ${count(bucketBytes)} bytes`,
  // The schedule's reset limit and a shared space's hourly wake and retry delay sit in modules typed for the Workers runtime, out of
  // this test's reach: the tests of those modules hold the three numbers.
  'pauses for a day after 3 tries in a row',
  'online devices hear about it within 1 hour',
  'at its hourly wake-up, up to 1 hour later',
  'get the change about 1 second later',
];

/** Statements whose numbers no constant of this repository gives: Cloudflare's limits, measurements, and names. */
const outside = [
  'Text must be valid UTF-16.',
  '`-0` is stored as `0`.',
  'inserting 10,000 rows into one bucket of a shared space took about 2 seconds of CPU. Moving each of them to another bucket took about 5 seconds.',
  'needs about 1.1 times the final database size',
  'needs about 2 times.',
  'One space holds at most 10 GB.',
  'Plan for about 1,000 devices online at once per shard',
  'a change reaching all 1,000 devices on one shard added about 70 ms',
  'any point in the last 30 days',
  'a compatibility date of 2026-04-07 or later',
  'object storage such as R2',
];

test.each(stated)('limits.md states: %s', (sentence) => {
  expect(limits).toContain(sentence);
});

test('every number limits.md writes in digits stands in a statement tied to the code, or in one listed as given by no constant', () => {
  let rest = limits;
  for (const sentence of [...stated, ...outside]) {
    expect(rest).toContain(sentence);
    rest = rest.replace(sentence, () => '');
  }
  expect(rest.match(numbers) ?? []).toEqual([]);
});

test('checksum verification waits a full day after completing a round', () => {
  expect(interval).toBe(24 * 3_600_000);
  expect(limits).toContain('a full day after the previous round completed');
});

test('the Chinese translation states the same numbers as the English limits', () => {
  const translation = readFileSync(new URL('../../docs/reference/zh-CN/limits.md', import.meta.url), 'utf8');
  const sorted = (text: string) => (text.match(numbers) ?? []).sort();
  expect(sorted(translation)).toEqual(sorted(limits));
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
