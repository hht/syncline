import type { Storage } from '../common/storage.ts';

// 测试拿云端当参照：最新一版（提交记录）、各客户端裁决到第几条（客户端表）、某条写有没有裁决（recordDecisions 记的）

export const head = (storage: Storage) => {
  const [row] = storage.sql.exec('SELECT version, nonce FROM _syncline_commit ORDER BY version DESC LIMIT 1').toArray();
  return { version: Number(row?.version), nonce: Number(row?.nonce) };
};

/** 云端每个客户端已裁决到第几条写（客户端表） */
export const lmids = (storage: Storage) =>
  new Map(
    storage.sql
      .exec('SELECT client, lmid FROM _syncline_client')
      .toArray()
      .map(({ client, lmid }) => [String(client), Number(lmid)]),
  );

/**
 * 云端记下每条裁决了的写（设备推来的，提交或扣下都算）：客户端表上的触发器在同一个事务里记一行客户端、序号与它的那一版
 * （客户端表在那一版的提交记录之前写），随时间点恢复一起回滚，不随截日志删。Space 建好客户端表之后调，再调不重复建。
 * 触发器写的行也算进计费的行写（rowsWritten），模拟里每条设备的写记的当天写了几行因此多 1
 */
export function recordDecisions(storage: Storage) {
  const record = 'INSERT INTO test_decided SELECT new.client, new.lmid, (SELECT max(version) + 1 FROM _syncline_commit)';
  storage.sql.exec('CREATE TABLE IF NOT EXISTS test_decided (client TEXT NOT NULL, id INTEGER NOT NULL, version INTEGER NOT NULL)');
  storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS test_decided_insert AFTER INSERT ON _syncline_client BEGIN ${record}; END`);
  storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS test_decided_update AFTER UPDATE ON _syncline_client BEGIN ${record}; END`);
}

/** 设备推来的写裁决了几条（拒收的也记一条空提交） */
export const decided = (storage: Storage) => storage.sql.exec('SELECT 1 FROM test_decided').toArray().length;

/** 被裁决了不止一次的写（客户端/序号） */
export const decidedTwice = (storage: Storage) =>
  storage.sql
    .exec('SELECT client, id FROM test_decided GROUP BY client, id HAVING count(*) > 1')
    .toArray()
    .map(({ client, id }) => `${String(client)}/${String(id)}`);

/** 这条写有没有裁决 */
const isDecided = (storage: Storage, client: string, id: number) =>
  storage.sql.exec('SELECT 1 FROM test_decided WHERE client = ? AND id = ?', client, id).toArray().length > 0;

type Write = { client: string; id: number };
const nameOf = ({ client, id }: Write) => `${client}/${id}`;

/** 一台设备待上传里的各条 */
const pendingRows = (storage: Storage) =>
  storage.sql
    .exec('SELECT seq, client, id FROM _syncline_pending ORDER BY seq')
    .toArray()
    .map((row) => ({ seq: Number(row.seq), client: String(row.client), id: Number(row.id) }));

/**
 * P8k（恢复不丢本机写）：设备发起的写最后都要有裁决，丢掉的只能是时间点恢复回滚掉的——恢复那一刻没有任何设备还留在待上传里的（永远丢了），
 * 与还留着、却被恢复前算出的应答确认掉的（提交到恢复生效之间的窗口）。每条待上传按本机的 seq 盯着：从待上传里消失时，
 * 云端当前历史上要有它的客户端与序号，没有就是被回滚掉的应答确认了。
 * 从备份恢复的设备不盯（备份之后的写本来就丢了，开着备份的种子不查总数）
 */
export class WriteLedger {
  /** 各设备待上传里盯着的写：seq → 它的客户端与序号 */
  readonly #tracked: Map<number, Write>[] = [];
  /** 永远丢了的写有几条 */
  lost = 0;

  /** 云端恢复到 at 之前的 image：before 是恢复前的云端；回滚掉、且没有任何设备还留着的写永远丢了 */
  rewound(before: Storage, at: number, devices: Storage[]) {
    const pending = new Set(devices.flatMap((storage) => pendingRows(storage).map(nameOf)));
    const cut = before.sql
      .exec('SELECT client, id FROM test_decided WHERE version > ?', at)
      .toArray()
      .map((row) => nameOf({ client: String(row.client), id: Number(row.id) }));
    this.lost += cut.filter((name) => !pending.has(name)).length;
  }

  /** 第 index 台设备换成了备份里的库：不再盯它之前的待上传 */
  restored(index: number) {
    this.#tracked[index] = new Map();
  }

  /** 每一步之后看各设备的待上传：消失的要已在云端提交，不然就是被回滚掉的应答确认掉了（丢了） */
  observe(cloud: Storage, devices: Storage[]) {
    for (const [index, storage] of devices.entries()) {
      const tracked = this.#tracked[index] ?? new Map<number, Write>();
      const rows = new Map(pendingRows(storage).map((row) => [row.seq, row]));
      for (const [seq, last] of tracked) if (!rows.has(seq) && !isDecided(cloud, last.client, last.id)) this.lost += 1;
      this.#tracked[index] = rows;
    }
  }
}
