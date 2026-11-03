import type { TableReads } from '../../../cloud/batches.ts';
import { decodeScan, encodeScan, type Scan } from '../../../cloud/position.ts';
import type { Checksum, ChecksumPart, Value } from '../../../common/protocol.ts';
import { fingerprintOf } from '../../../tables/fingerprint.ts';
import { plus, rangeRows, rowText } from '../common/checksum.ts';

/**
 * 私有空间的校验和怎么算：设备要时（拉取带 checksum）当场算一段，按整份扫描的先后（表名、主键）从 cursor 起读同步表、
 * 设备看得到的列，每行的哈希相加，一段至多 rangeRows 行（设备要的更少时照设备的）、约 rangeChars 个字符、rangeParts 张表；给出这一段是哪几部分
 * （每张表从哪个主键到哪个主键）、有几行、和与下一段从哪起，设备按同样的主键范围算本机的这一段比；最后一段另带全部同步表，
 * 设备把别的表还存着的行也算进来。
 * 一段在一次请求的 CPU 之内，表多大都一样；提交时不记、要时现算，按当前的同步范围算，范围怎么变都不用另外维护。
 * 不该知道的：行怎么写、提交怎么记、设备多久要一次。
 * @see https://docs.powersync.com/architecture/powersync-protocol
 */

/** 一段约几个字符（行的哈希文字）：行可以接近单个值的上限，除了行数另按字符数封顶 */
export const rangeChars = 8_000_000;

/** 一段至多几张表：回复里每张表一项，对不上时设备把各部分原样放进按范围重下的拉取，一段的回复与重下的请求不随表数涨 */
export const rangeParts = 100;

/**
 * 从 cursor 起算一段的校验和，至多 limit 行（不超过 rangeRows）。cursor 是上一段给的 next：读取器的扫描点，
 * 照整份扫描的先后（表名、主键）接着读，部署加减了表也接着，起点那张表不再同步就从下一个表名起；空串（从头）、认不出的从第一张表起
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
    // 表够多了：下一段从这张表起
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

/** 从扫描点 start 起要读的表与各自从哪个主键之后读：表名在它之前的跳过，它那张表从它的主键之后；没有起点是全部表 */
const startingAt = (order: { table: string; key: string[] }[], start: Scan | undefined) =>
  order
    .filter(({ table }) => !start || table >= start.table)
    .map((entry) => ({ ...entry, after: entry.table === start?.table ? start.after : undefined }));
