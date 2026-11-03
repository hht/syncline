import { valueChars } from './limits.ts';
import type { Query } from './storage.ts';

/**
 * Syncline 拼 SQL 的通用写法。名字与文字拼进 SQL 只有一种写法：表名、列名、索引名一律经 quote，字符串字面量（含 JSON 路径）一律经 literal，
 * 名字里的引号转义后照样合法；表名、列名只有字母、数字、下划线（声明检查），索引名里可能有引号。
 * 另有几种与哪张表无关的片段（几列各等于一个参数、一组值的 IN 条件分批、一行的字节数）与查表上的列。
 * 不该知道的：拼的是哪条语句
 * @see https://sqlite.org/lang_keywords.html
 */

/** 一个名字（表、列、索引）：包上双引号，名字里的双引号写两遍 */
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export const quoteAll = (names: readonly string[]) => names.map(quote).join(', ');

/** 按这几列各等于一个参数：列名 = ? AND … */
export const whereKey = (columns: readonly string[]) => columns.map((column) => `${quote(column)} = ?`).join(' AND ');

/** 字符串字面量：包上单引号，里面的单引号写两遍 */
export const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** 一张表在库里的列：PRAGMA table_info 的每一行（name、type、notnull、dflt_value、pk） */
export const tableColumns = (query: Query, table: string) => query(`PRAGMA table_info(${quote(table)})`);

/** 一行按多少字节算：各列 octet_length 之和（SQL） */
export const sizedBy = (columns: readonly string[]) => columns.map((column) => `ifnull(octet_length(${quote(column)}), 0)`).join(' + ');

/**
 * 列 columns 的值在一组值里（rows 各行这几列的值），返回每批的条件与参数：这组值作一个 JSON 参数传，不受绑定参数个数的上限（DO 100 个），
 * 每批一条语句、不随值的个数多出语句；一个参数又要在单个值的上限之内，所以按 valueChars 个字符分批
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/（SQL storage limits）
 */
export function among(columns: string[], rows: Record<string, unknown>[]) {
  const condition = `(${quoteAll(columns)}) IN (SELECT ${columns.map((_, index) => `json_extract(value, '$[${index}]')`).join(', ')} FROM json_each(?))`;
  const batches: [string, string][] = [];
  let part: string[] = [];
  let size = 0;
  for (const row of rows) {
    const value = JSON.stringify(columns.map((column) => row[column]));
    if (part.length > 0 && size + value.length > valueChars) {
      batches.push([condition, `[${part.join(',')}]`]);
      part = [];
      size = 0;
    }
    part.push(value);
    size += value.length + 1;
  }
  if (part.length > 0) batches.push([condition, `[${part.join(',')}]`]);
  return batches;
}
