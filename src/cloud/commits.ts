import { batchRows, commitFloor, readBytes, truncateBytes, truncateRows, valueBytes } from '../common/limits.ts';
import type { Cookie } from '../common/protocol.ts';
import { utf8Bytes } from '../common/size.ts';
import type { Query } from '../common/storage.ts';
import type { Key } from '../tables/keys.ts';
import { within } from './batches.ts';

/**
 * 一个空间的提交记录怎么记、怎么查：整个空间一个版本号，每处理一条写记一版，记下改到的行（[表名, 主键]）
 * 与随机数；同步范围的变化也记在这里（离开同步的表或列，与数据改动同一条日志）；最新一版、某版本之后改了哪些行都从这里查。
 * 各客户端处理到第几条另记在客户端表，随这个客户端的每条提交在同一个事务里写，永不删：按主键查，不随提交记录涨；
 * 设备的写的提交另记客户端编号，连上时的补齐据此找出游标之后有提交的客户端（lmidsSince）。
 * 提交记录按字节封顶：截掉最早的，下限那一版的随机数与累计字节另记一行，游标在它及之后的仍在当前历史上（模型的 Truncate）。
 * 都在调用方开好的事务里执行；表与 Syncline 自己的其他表一起建。
 * 不该知道的：改到的行怎么写、怎么下发。
 * @see https://doc.replicache.dev/strategies/per-space-version
 * @see https://github.com/rocicorp/mono/blob/945ce619249e63381fb51d46c12f0d9e80024860/packages/zero-cache/src/services/mutagen/mutagen.ts（checkSchemaVersionAndIncrementLastMutationID）
 */

/**
 * 提交记录的一项：改到的一行 [表名, 主键]（主键是规范写法 canonicalKey；共用空间另带改前或改后它在的桶 [表名, 主键, 桶]），
 * 或离开了同步的一张表 [表名, null]、一张表的几列 [表名, null, 列名]。进入同步、加了同步的列、共用空间改了可见范围不记项：
 * 范围表记下从哪一版起，那一版是一次不带键的提交，拉取据此扫这张表
 */
export type Entry = [string, Key] | [string, Key, string[]] | [string, null] | [string, null, string[]];
/** 一次提交的各项 */
export type Keys = Entry[];

/** 一项改到的那一行的主键；离开同步的不是一行，是 undefined */
const rowKeyOf = ([, key]: Entry) => key ?? undefined;

/** 各项里改到的行 [表名, 主键]（跳过离开同步的） */
export const changedRows = (keys: Keys) =>
  keys.flatMap((entry): [string, Key][] => {
    const key = rowKeyOf(entry);
    return key ? [[entry[0], key]] : [];
  });
/** 设备推来的写当天（UTC，自 Unix 纪元起第几天）共写了几行，记在设备的写的提交记录上 */
export type Used = { day: number; rows: number };

/** 64 位里取 JS 数字能精确表示的 53 位 */
const nonce = () => Number((crypto.getRandomValues(new BigUint64Array(1))[0] ?? 0n) >> 11n);

const keysOf = (keys: unknown) => JSON.parse(String(keys)) as Keys;

/** 客户端表的几行：客户端 → 处理到第几条 */
const lmidsOf = (rows: Record<string, unknown>[]) => Object.fromEntries(rows.map(({ client, lmid }) => [String(client), Number(lmid)]));

/** 提交记录一行除了主键之外约占多少字节（其余各列、SQLite 的记录头与单元指针；设备的写另有约 36 字节的客户端编号，都按有算） */
export const rowOverhead = 72;

/** 提交记录一行的主键最多多少字节（UTF-8）：单个值的上限留一半余地 */
const keysLimit = valueBytes / 2;

/** 边写边记的一次提交（Commits 的 begin）：add 追加一项，finish 记下最后一段 */
export type Recording = { add: (entry: Entry) => void; finish: (revise?: (keys: Keys) => Keys) => Cookie };

export class Commits {
  readonly #query: Query;
  readonly #chunkRows: number | undefined;
  readonly #floor: number;
  /** 最后一个块边界之后的提交共改到几行；第一次记提交时从库里算 */
  #open: number | undefined;

  /**
   * chunkRows：共用空间每满这么多行（改到的行）记一个块边界，私有空间不给、不记；
   * floor：日志的上限至少多少字节（默认 commitFloor，测试里调小）
   */
  constructor(
    query: Query,
    { chunkRows, commitFloor: floor = commitFloor }: { chunkRows?: number | undefined; commitFloor?: number | undefined } = {},
  ) {
    this.#query = query;
    this.#chunkRows = chunkRows;
    this.#floor = floor;
  }

  /** 空间的这一代：第 0 版（空库，建空间时记下）的随机数，另记一行，清空重建后不同（共用空间用） */
  incarnation() {
    const [row] = this.#query('SELECT nonce FROM _syncline_incarnation');
    if (!row) throw new Error('没有记下空间的这一代');
    return Number(row.nonce);
  }

  /** 最新一版；还没有提交是第 0 版 */
  head(): Cookie {
    return this.#cookie('SELECT version, nonce FROM _syncline_commit ORDER BY version DESC LIMIT 1');
  }

  /** 一次记下一版不是设备的写的各项（已经在内存里的，如离开同步的表与列；空数组是一版不带键的提交）：照 begin 记，返回记下的最后一版 */
  record(keys: Keys) {
    const recording = this.begin(null, null);
    for (const entry of keys) recording.add(entry);
    return recording.finish().version;
  }

  /**
   * 边写边记一次提交：改到的一行报出来就 add，主键攒过 keysLimit 字节就记成一版写进库、接着记下一段，
   * 内存里只留一段，一次写改到多少行都一样（提交记录一行要在单个值的上限之内）。共用空间每满一定行数记一个块边界。
   * 记最后一版时把客户端处理到的序号写进客户端表，几版在调用方的同一个事务里，
   * 设备的游标只会落在最后一版（通知与末块都带最新一版），中间的几版只出现在拉取的 cursor 里；写到一半最新一版已经往前走了。
   * finish 先把已写进库的各段读回来交给 revise 改定（校验、补上写完之后它在的桶；变了就改写），再改定、记下最后一段
   * （一项也没有时也记一版：不改行的提交，如同步范围变了），出错整条回滚。reserve：改定时一项至多再长多少字节，切段时预留，
   * 改定后照样在单个值的上限之内。used 给出设备的写当天到此刻写了几行，记进每一版（中间几版是写到那一刻的）；别的提交不给，照抄上一版记的（不算它们写的行），对象醒来后读最新一版就接着算。
   * finish 返回记下的最后一版（新的最新一版）
   */
  begin(
    client: string | null,
    id: number | null,
    { used, reserve = 0 }: { used?: (() => Used) | undefined; reserve?: number } = {},
  ): Recording {
    // 块边界之后共几行：先算再记（记了之后再算会把这次的行算两遍），写成功才记到对象上（出错回滚时不留下）
    const boundary = () => Number(this.#query('SELECT ifnull(max(version), 0) AS v FROM _syncline_boundary')[0]?.v);
    let open = this.#chunkRows === undefined ? 0 : (this.#open ?? this.#countSince(boundary()));
    // 接着最新一版往上记：head 是记到的最新一版，累计字节与当天写了几行（别的提交照抄）也从它接着算
    const latest = this.#latest();
    let head: Cookie = { version: Number(latest.version), nonce: Number(latest.nonce) };
    let total = Number(latest.bytes);
    const writtenVersions: number[] = [];
    let part: Entry[] = [];
    let bytes = 2;
    const insert = (keys: Keys, last: boolean) => {
      head = { version: head.version + 1, nonce: nonce() };
      // 序号由调用方定（比处理到的大），这里照写；先写它，当天写了几行才算得进去。客户端编号也只记在最后一版（游标只落在它上，lmidsSince）
      if (last && client !== null)
        this.#query('INSERT INTO _syncline_client VALUES (?, ?) ON CONFLICT (client) DO UPDATE SET lmid = excluded.lmid', client, id);
      const today = used?.();
      const text = JSON.stringify(keys);
      // 累计字节接着上一版往上加，按写进去时的算：finish 改定时一项至多再长 reserve 字节（共用空间补上它在的桶），是估计、偏差有上界
      total += utf8Bytes(text);
      this.#query(
        'INSERT INTO _syncline_commit (version, nonce, keys, day, used, bytes, client) VALUES (?, ?, ?, ?, ?, ?, ?)',
        head.version,
        head.nonce,
        text,
        today?.day ?? latest.day ?? null,
        // 加上这一行提交记录：表只有 rowid 主键、没有别的索引，一行计一行
        today ? today.rows + 1 : (latest.used ?? null),
        total,
        last ? client : null,
      );
      if (this.#chunkRows === undefined) return;
      open += keys.length;
      if (open < this.#chunkRows) return;
      this.#query('INSERT INTO _syncline_boundary VALUES (?)', head.version);
      open = 0;
    };
    return {
      add: (entry) => {
        const size = utf8Bytes(JSON.stringify(entry)) + 1 + reserve;
        if (part.length > 0 && bytes + size > keysLimit) {
          insert(part, false);
          writtenVersions.push(head.version);
          part = [];
          bytes = 2;
        }
        part.push(entry);
        bytes += size;
      },
      finish: (revise = (keys) => keys) => {
        for (const at of writtenVersions) this.#revise(at, revise);
        insert(revise(part), true);
        if (this.#chunkRows !== undefined) this.#open = open;
        return head;
      },
    };
  }

  /** 最新一版的那一行（begin 接着它往上记）：最新一版不会被截掉（truncate），总在提交记录里 */
  #latest() {
    const [row] = this.#query('SELECT version, nonce, bytes, day, used FROM _syncline_commit ORDER BY version DESC LIMIT 1');
    if (!row) throw new Error('提交记录是空的');
    return row;
  }

  /** 把已写进库的一版读回来交给 revise 改定；改定后没变（私有空间原样返回，共用空间补上的桶与已有的一样）不改写：行写按行计费 */
  #revise(version: number, revise: (keys: Keys) => Keys) {
    const text = String(this.#query('SELECT keys FROM _syncline_commit WHERE version = ?', version)[0]?.keys);
    const revised = JSON.stringify(revise(keysOf(text)));
    if (revised !== text) this.#query('UPDATE _syncline_commit SET keys = ? WHERE version = ?', revised, version);
  }

  /** 最近一次记下的当天写了几行（含那一行提交记录）；还没有设备的写是 undefined。每版照抄上一版（begin），最新一版就是最近记下的；对象醒来后读一次 */
  used(): Used | undefined {
    const { day, used } = this.#latest();
    return day === null ? undefined : { day: Number(day), rows: Number(used) };
  }

  /**
   * 最近的块边界（共用空间整份的水位）；还没有边界是版本 0，边界已截掉时是截后最早的一版。块边界只看提交记录：
   * 同一段时间里起拉整份的设备水位相同，落在同一串网址上
   * @see https://github.com/electric-sql/electric/blob/3f9809fb0bd894cb74470d434749673492ad7acf/packages/sync-service/lib/electric/shape_cache/log_chunker.ex
   */
  watermark(): Cookie {
    return this.#cookie(
      'SELECT version, nonce FROM _syncline_commit WHERE version >= (SELECT ifnull(max(version), 0) FROM _syncline_boundary) ORDER BY version LIMIT 1',
    );
  }

  /** 查出提交记录里的一版：最新一版总在（截日志不删它） */
  #cookie(sql: string) {
    const [row] = this.#query(sql);
    if (!row) throw new Error('提交记录是空的');
    return { version: Number(row.version), nonce: Number(row.nonce) };
  }

  /** 当前历史上的一版：提交记录里的，或截日志截到的下限那一版；截掉了、还没有的是 undefined */
  #row(version: number) {
    const [row] = this.#query(
      'SELECT nonce, bytes FROM _syncline_commit WHERE version = ? UNION ALL SELECT nonce, bytes FROM _syncline_low WHERE version = ?',
      version,
      version,
    );
    return row && { nonce: Number(row.nonce), bytes: Number(row.bytes) };
  }

  /**
   * 游标是不是当前历史上的某一版：那一版还在（不晚于最新、不早于日志下限），且随机数对得上（时间点恢复回滚掉的那几版，随机数对不上）；
   * 低于下限的认不出，设备从头整份
   */
  onHistory({ version, nonce }: Cookie) {
    return this.#row(version)?.nonce === nonce;
  }

  /** 客户端处理到第几条；没推过是 0 */
  lmid(client: string) {
    const [row] = this.#query('SELECT lmid FROM _syncline_client WHERE client = ?', client);
    return row ? Number(row.lmid) : 0;
  }

  /**
   * 版本 from 之后有提交的客户端各处理到第几条（模型的 LmidsSince）：再读一遍这段提交记录取出客户端编号，按主键查客户端表，
   * 读的行数至多约这段提交数的 3 倍（每版一个不同的客户端时，规模门禁守着）；from 要在当前历史上（这段提交都还在）。
   * 子查询的列带表名：列缺了报错，不悄悄当成外层的列
   */
  lmidsSince(from: number) {
    return lmidsOf(
      this.#query(
        'SELECT client, lmid FROM _syncline_client WHERE client IN (SELECT _syncline_commit.client FROM _syncline_commit WHERE version > ? AND _syncline_commit.client IS NOT NULL)',
        from,
      ),
    );
  }

  /** 这几个客户端处理到第几条（没推过的不给）：客户端列表作一个 JSON 参数传，不受绑定参数个数的上限（DO 100 个） */
  lmidsOf(clients: Iterable<string>) {
    return lmidsOf(
      this.#query(
        'SELECT client, lmid FROM _syncline_client WHERE client IN (SELECT value FROM json_each(?))',
        JSON.stringify([...clients]),
      ),
    );
  }

  /** 到 version 这一版为止的各版主键共多少字节（累计字节）；这一版要在当前历史上（最新一版、核对过的游标） */
  bytesAt(version: number) {
    const row = this.#row(version);
    if (!row) throw new Error(`提交记录里没有第 ${version} 版`);
    return row.bytes;
  }

  /** 日志约占多少字节：下限之后各版的主键（累计字节相减），加上每版一行的其余列与 SQLite 的开销（rowOverhead） */
  bytes() {
    const [low] = this.#query('SELECT version, bytes FROM _syncline_low');
    const head = this.head().version;
    return this.bytesAt(head) - Number(low?.bytes ?? 0) + (head - Number(low?.version ?? 0)) * rowOverhead;
  }

  /** 日志超了上限：至少 floor 字节，数据（库文件 databaseSize 减日志）多了按它的 1/4 */
  overLimit(databaseSize: number) {
    const bytes = this.bytes();
    return bytes > this.#cap(databaseSize, bytes);
  }

  #cap(databaseSize: number, bytes: number) {
    return Math.max(this.#floor, (databaseSize - bytes) / 4);
  }

  /**
   * 截日志的一步（后台任务做，在调用方开好的事务里）：从下限往后至多 truncateRows 版、主键共 truncateBytes 字节里，删到剩下的日志不超过上限的 3/4 为止
   * （target，不给就按 databaseSize 算），最新一版不删；删到的最后一版记成新的下限。返回还要不要接着截（还不够、又还有可删的）
   */
  truncate(databaseSize: number, target = this.#cap(databaseSize, this.bytes()) * 0.75) {
    const head = this.head().version;
    const [low] = this.#query('SELECT version, bytes FROM _syncline_low');
    // 还没截过时下限是第 0 版（空库），删第一段时它随之删掉
    const from = Number(low?.version ?? 0);
    const lowBytes = Number(low?.bytes ?? 0);
    // 删到第 v 版时剩下的约是 (累计字节(最新) + 最新 × rowOverhead) − (累计字节(v) + v × rowOverhead)，后一项要至少 needed
    const needed = this.bytesAt(head) + head * rowOverhead - target;
    const last = Math.min(from + truncateRows, head - 1);
    if (needed <= lowBytes + from * rowOverhead || last <= from) return false;
    // 两项随版本都只增不减：从下限往后第一个够了或删多了的，够了就删到它，删多了删到它前一版（至少删一版）；这一段里都不是就删满这一段
    const [stop] = this.#query(
      'SELECT version, nonce, bytes FROM _syncline_commit WHERE version > ? AND version <= ? AND (bytes + version * ? >= ? OR bytes > ?) ORDER BY version LIMIT 1',
      from,
      last,
      rowOverhead,
      needed,
      lowBytes + truncateBytes,
    );
    const over = stop !== undefined && Number(stop.bytes) > lowBytes + truncateBytes;
    const to = stop === undefined ? last : over ? Math.max(Number(stop.version) - 1, from + 1) : Number(stop.version);
    const cut =
      Number(stop?.version) === to ? stop : this.#query('SELECT version, nonce, bytes FROM _syncline_commit WHERE version = ?', to)[0];
    if (!cut) throw new Error(`提交记录里没有第 ${to} 版`);
    this.#query('DELETE FROM _syncline_commit WHERE version <= ?', cut.version);
    this.#query('DELETE FROM _syncline_boundary WHERE version <= ?', cut.version);
    this.#query('INSERT OR REPLACE INTO _syncline_low VALUES (1, ?, ?, ?)', cut.version, cut.nonce, cut.bytes);
    return Number(cut.version) < head - 1 && Number(cut.bytes) + Number(cut.version) * rowOverhead < needed;
  }

  /** 版本 from 之后的一批提交，按版本，至多 batchRows 版、主键共约 readBytes 字节（UTF-8，见 within）；read 是读了几行（量字节与取正文各读一遍） */
  after(from: number) {
    const sizes = this.#query(
      'SELECT octet_length(keys) AS bytes FROM _syncline_commit WHERE version > ? ORDER BY version LIMIT ?',
      from,
      batchRows,
    );
    const commits = this.#query(
      'SELECT version, nonce, keys FROM _syncline_commit WHERE version > ? ORDER BY version LIMIT ?',
      from,
      within(sizes, readBytes),
    ).map((commit) => ({ cookie: { version: Number(commit.version), nonce: Number(commit.nonce) }, keys: keysOf(commit.keys) }));
    return { commits, read: commits.length * 2 };
  }

  /** 版本 from 之后的提交共有几项（不去重） */
  #countSince(from: number) {
    return Number(
      this.#query('SELECT ifnull(sum(json_array_length(keys)), 0) AS total FROM _syncline_commit WHERE version > ?', from)[0]?.total,
    );
  }
}
