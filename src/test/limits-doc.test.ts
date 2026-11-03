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

// 写给接入方的上限文档与代码里的常数一致：每一句由常数现算，改了常数没改文档就失败。设备一侧的数取自 Rust 的核心

const { pushLimit, receiveTimeout, pingAfter, pongWithin, baseDelay, maxDelay, maxRowBytes, batch, rowsPerDay, interval, askAgainAfter } =
  rustLimits();

const limits = readFileSync(new URL('../../docs/reference/limits.md', import.meta.url), 'utf8');

/** 按「万」写：2.4 万、1,600 万 */
const wan = (value: number) => `${(value / 10_000).toLocaleString('en')} 万`;
const seconds = (ms: number) => `${ms / 1000} 秒`;
const mib = (bytes: number) => `${bytes / 2 ** 20} MiB`;
const mb = (bytes: number) => `${bytes / 1_000_000} MB`;

test.each([
  // 大小
  `${mib(writeBytes)}（UTF-8）`,
  `超过 ${mib(pushBytes)}（UTF-8）`,
  `拉取的正文超过 ${mb(pullBytes)}（UTF-8）`,
  `改动约 ${wan(pushLimit)}字节`,
  `至多 ${pushMutations} 条写`,
  `同时 ${defaultConnections} 条`,
  `整条消息 ${wan(socketLimit)}字节`,
  `最慢按每秒 ${slowestRate / 1000} KB 算`,
  `不超过 ${wan(noticeBudget)}`,
  `私有空间约 ${wan(chunkLimit)}字符`,
  `至多读库里 ${wan(readRows)}行`,
  `默认 ${defaultRows} 行（\`chunkRows\`）`,
  `编成 JSON 共 ${keyBytes} 字节`,
  `编成 JSON 至多 ${subscriptionBytes} 字节`,
  `一个桶至多 ${bucketBytes} 字节`,
  `同步的列共 ${maxRowBytes.toLocaleString('en')} 字节（DO 一行最多 ${mb(valueBytes)}`,
  `约 ${mib(commitFloor)} 与数据`,
  `每版约 ${rowOverhead} 字节`,
  `至多删 ${wan(truncateRows)}版、主键共 ${mib(truncateBytes)}`,
  `默认 ${defaultShards} 片`,
  `${wan(writeRows)}行（共用空间只有服务端写，至多 ${wan(sharedWriteRows)}行：每行还要维护它在的桶），主键编成 JSON 共 ${mb(writeKeyBytes)}`,
  `至多 ${wan(rangeRows)}行、约 ${wan(rangeChars)}字符、${rangeParts} 张表`,
  `至多减到 ${batch} 行`,
  `每天至多要 ${wan(rowsPerDay)}行`,
  // 时长
  `${seconds(receiveTimeout)}没收到任何数据`,
  `空闲 ${seconds(pingAfter)}发一次 ping，${seconds(pongWithin)}内没有任何消息`,
  `min(${seconds(maxDelay)}, ${seconds(baseDelay)} × 2ⁿ)`,
  `每秒 ${reconnectRate} 台`,
  `写了之后 ${seconds(defaultExportDelay)}（\`exportDelay\`）`,
  `最多 ${maxExportDelay / 3_600_000} 小时`,
  `最多导 ${defaultExportBudget / 60_000} 分钟（\`exportBudget\`）`,
])('limits.md 写着：%s', (sentence) => {
  expect(limits).toContain(sentence);
});

test('写成汉字的：校验和对完一轮满一天再对、要了没对成至多每分钟再要一次', () => {
  expect([interval, askAgainAfter]).toEqual([24 * 3_600_000, 60_000]);
  expect(limits).toContain('上次对完一轮满一天');
  expect(limits).toContain('至多每分钟再要一次');
});

test('Rust 的设备一侧与云端共用的上限一样', () => {
  expect(rustLimits()).toMatchObject({ valueBytes, valueChars, keyBytes, writeRows, writeKeyBytes });
});

test('web 的外壳按核心的时长判 HTTP 拉取停住（原生的外壳直接取核心的常数）', () => {
  expect(shellReceiveTimeout).toBe(receiveTimeout);
});
