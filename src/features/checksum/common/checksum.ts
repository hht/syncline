import { fingerprintOf } from '../../../tables/fingerprint.ts';

/**
 * 一个空间的数据的校验和：每行的哈希相加（对 2^32 取模）。
 * 按整份扫描的先后分段，云端当场算一段，设备算本机同一段、对一对：对不上就是某处缺陷、存储损坏让两端悄悄分了叉，测试漏掉的也能发现。
 * 一行按设备看得到的值算：表名与不为空的列，按列名排好序的 JSON 取 FNV-1a；空的列不算，两端的表定义不一致时多出的列都是空。
 * 不该知道的：行从哪读、对不上之后怎么办。
 * @see https://docs.powersync.com/architecture/powersync-protocol
 */

/**
 * 一段至多几行（设备要的更少时照设备的）：Cloudflare 上当场算 100 万行两列的短行约 3.6 秒、9 列的约 7 秒 CPU，
 * 2 万行在 0.2 秒之内
 */
export const rangeRows = 20_000;

export const rowHash = (table: string, row: Record<string, unknown>) => fingerprintOf(rowText(table, row));

/** 一行拿去算哈希的文字：表名与不为空的列，按列名排好序的 JSON */
export function rowText(table: string, row: Record<string, unknown>) {
  const values = Object.keys(row)
    .filter((column) => row[column] !== null && row[column] !== undefined)
    .sort()
    .map((column) => [column, row[column]]);
  return JSON.stringify([table, values]);
}

export const plus = (sum: number, hash: number) => (sum + hash) >>> 0;

/** 一组行的哈希之和 */
export const checksumOf = (hashes: Iterable<number>) => [...hashes].reduce(plus, 0);
