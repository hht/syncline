import { queryOf, type Storage } from '../common/storage.ts';

/**
 * Syncline 在云端库里自己的表长什么样、在库里是第几版：每一版都写在这里（设备库的在 Rust 的核心里），
 * 版本表每版一行，存着退回上一版的语句；库比代码旧就逐版执行 up，库比代码新（Worker 回滚到更早的发布）就从最新一版起
 * 执行库里存的 down，退回代码认识的版本。版本记在自己的表里，不占 PRAGMA user_version（那是接入方管自己的表用的）。
 * 整个过程在一个事务里，哪步失败库保持原样。加一版只在 steps 末尾加一项。
 * 不该知道的：表里的数据怎么用。
 * @see https://github.com/powersync-ja/powersync-sqlite-core/blob/main/crates/core/src/migrations.rs
 */

/** 一版：up 从上一版升上来的语句，down 退回上一版的语句（存进库里，给以后回滚到这一版之前的代码执行） */
type Step = { up: string[]; down: string[] };

/** 各版，第 n 版是第 n 项 */
const steps: Step[] = [
  {
    up: [
      // 提交记录：只记改到的行的键；bytes 是到这一版为止的各版主键共多少字节（UTF-8），日志多大、游标之后还要追多少都是两版相减，不用扫提交记录；
      // day、used：设备推来的写写完这一行提交记录时，当天（UTC，自 Unix 纪元起第几天）共写了几行，别的提交照抄上一版的；
      // client：设备的写记在它的最后一版上，别的提交是 NULL
      'CREATE TABLE _syncline_commit (version INTEGER PRIMARY KEY, nonce INTEGER NOT NULL, keys TEXT NOT NULL, day INTEGER, used INTEGER, bytes INTEGER NOT NULL, client TEXT)',
      // 第 0 版（空库）：随机数在建空间时定一次（53 位以内），清空重建的空间与之前的不同，旧空间上的游标与下载到一半的位置都认不出
      "INSERT INTO _syncline_commit (version, nonce, keys, bytes) VALUES (0, abs(random() % 9007199254740992), '[]', 0)",
      // 空间的这一代（共用空间用）：第 0 版的随机数另记一行，截日志截掉第 0 版也还在
      'CREATE TABLE _syncline_incarnation (one INTEGER PRIMARY KEY CHECK (one = 1), nonce INTEGER NOT NULL)',
      'INSERT INTO _syncline_incarnation SELECT 1, nonce FROM _syncline_commit WHERE version = 0',
      // 日志下限：截日志截到的那一版与它的随机数、累计字节，之前的提交都已删；一行，还没截过没有
      'CREATE TABLE _syncline_low (one INTEGER PRIMARY KEY CHECK (one = 1), version INTEGER NOT NULL, nonce INTEGER NOT NULL, bytes INTEGER NOT NULL)',
      // 客户端表：每个客户端处理到第几条，永不删，随它的每条提交在同一个事务里写
      'CREATE TABLE _syncline_client (client TEXT PRIMARY KEY, lmid INTEGER NOT NULL) WITHOUT ROWID',
      // 共用空间的块边界：每满一定行数（改到的行）记一个版本，只看提交记录；私有空间不记
      'CREATE TABLE _syncline_boundary (version INTEGER PRIMARY KEY)',
      // 扣下的写（待修复）：执行不了的写照样推进序号，原样的改动分几行存在这里；每次推送与末块都按版本查这段里扣下的（since）
      'CREATE TABLE _syncline_held (client TEXT NOT NULL, mutation_id INTEGER NOT NULL, part INTEGER NOT NULL, version INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, changes TEXT NOT NULL, PRIMARY KEY (client, mutation_id, part))',
      'CREATE INDEX _syncline_held_version ON _syncline_held (part, version)',
      // 同步过的表与列、删掉的名字与时刻：打开时与声明比出进入、离开同步的
      'CREATE TABLE _syncline_synced (tbl TEXT NOT NULL, col TEXT NOT NULL, PRIMARY KEY (tbl, col)) WITHOUT ROWID',
      'CREATE TABLE _syncline_retired (name TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID',
      // 范围表：每张表最近一次进入同步（含加列）是哪一版，拉取据此扫它；没有记录的从第 0 版起就在同步
      'CREATE TABLE _syncline_scope (tbl TEXT PRIMARY KEY, since INTEGER NOT NULL) WITHOUT ROWID',
      // 共用空间每张表上次打开时的桶规则的规范写法：变了这张表从下一版起重扫
      'CREATE TABLE _syncline_rules (tbl TEXT PRIMARY KEY, definition TEXT NOT NULL) WITHOUT ROWID',
      // 共用空间每个桶有多少行：按表、这张表的第几代与桶记；每张表的行数是第几代、数到哪了
      // （after 是数到的主键，各列的值按主键的先后编成 JSON；'[]' 是还没开始，NULL 是数完了）
      'CREATE TABLE _syncline_bucket_rows (tbl TEXT NOT NULL, gen INTEGER NOT NULL, bucket TEXT NOT NULL, rows INTEGER NOT NULL, PRIMARY KEY (tbl, gen, bucket)) WITHOUT ROWID',
      'CREATE TABLE _syncline_counted (tbl TEXT PRIMARY KEY, gen INTEGER NOT NULL, after TEXT) WITHOUT ROWID',
      // 一个对象一张定时表；failures 是 Syncline 自己的事连着失败了几次，按它退避重排，不在退避中是 0
      'CREATE TABLE _syncline_schedule (name TEXT PRIMARY KEY, at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0)',
    ],
    down: [],
  },
];

/** 把库里 Syncline 自己的表升或退到代码要的那一版 */
export function prepareInternalTables(storage: Storage) {
  const query = queryOf(storage);
  storage.transactionSync(() => {
    query('CREATE TABLE IF NOT EXISTS _syncline_schema (version INTEGER PRIMARY KEY, down TEXT NOT NULL)');
    for (const { down } of query('SELECT down FROM _syncline_schema WHERE version > ? ORDER BY version DESC', steps.length))
      for (const sql of JSON.parse(String(down)) as string[]) query(sql);
    query('DELETE FROM _syncline_schema WHERE version > ?', steps.length);
    const current = Number(query('SELECT ifnull(max(version), 0) AS version FROM _syncline_schema')[0]?.version);
    for (const [offset, { up, down }] of steps.slice(current).entries()) {
      for (const sql of up) query(sql);
      query('INSERT INTO _syncline_schema VALUES (?, ?)', current + offset + 1, JSON.stringify(down));
    }
  });
}
