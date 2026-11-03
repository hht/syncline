import { Server } from '../cloud/server.ts';
import type { Storage } from '../common/storage.ts';
import { protocolVersion } from '../common/version.ts';
import { Space } from './test-checksum.ts';
import { decidedTwice, head, recordDecisions } from './test-commits.ts';
import { CloudHistory, createMemo, keys, labelsIn, type Releases, RevivalCheck, schema, serverInc } from './test-counter.ts';
import type { CloudEnd, Network } from './test-network.ts';
import { cloudStorage, InjectedFault, isInjected, restoredStorage } from './test-storage.ts';
import type { Tracer } from './test-trace.ts';

// 确定性模拟里的云端：一个私有空间的对象（真的 Server 与 Space），与在它上面发生的事——存储故障、部署、
// 协议版本回滚、发布、时间点恢复、服务端的写。什么时候发生由模拟挑；它们在模型里的动作记进轨迹

/** 每块拉取约多少字符：整份与增量拉取都分好几块 */
const chunkLimit = 400;

/** 日志的上限：库文件的大小报成 0，上限就是它，十来次写就要截 */
const commitFloor = 600;

/** 一批推送至多尝试改几行：调到 2 行，攒下的几条写一批推上来时云端常只处理前缀，设备接着推剩下的 */
const pushRows = 2;

export class SimulatedCloud {
  storage = cloudStorage(...schema, createMemo);
  server: Server<CloudEnd>;
  #space: Space;
  /** 每一版的云端（P5 按它查设备） */
  readonly history = new CloudHistory();
  /** 时间点恢复了几次；P8r 查回滚掉、没有设备还留着的写不复活 */
  restores = 0;
  readonly revival = new RevivalCheck();
  /** 对象的存储还要执行几条语句就出故障；0 是不出（#serve） */
  #fault = 0;
  readonly #network: Network;
  readonly #releases: Releases;
  readonly #tracer: Tracer | undefined;
  readonly #pick: <T>(items: T[]) => T | undefined;
  readonly #random: () => number;
  /** 恢复改了时间线：丢了哪些写、哪些不许复活据此记下（WriteLedger、RevivalCheck）；给出恢复前的云端与恢复到的版本 */
  readonly #rewound: (before: Storage, at: number) => Set<string>;

  constructor(
    network: Network,
    releases: Releases,
    tracer: Tracer | undefined,
    random: () => number,
    rewound: (before: Storage, at: number) => Set<string>,
  ) {
    this.#network = network;
    this.#releases = releases;
    this.#tracer = tracer;
    this.#random = random;
    this.#pick = (items) => items[Math.floor(random() * items.length)];
    this.#rewound = rewound;
    [this.#space, this.server] = this.#serve();
    this.history.record(this.storage);
  }

  /**
   * 对象（重新）启动：云端的存储另包一层给它，armed 之后它执行的第几条读写语句抛 InjectedFault（I/O 错；测试自己读云端不算）。
   * 平台遇到 SQLite 严重出错就重置对象：出错的那次调用失败、连接全断，推了一半的一批里已提交的留着
   */
  #serve() {
    this.#fault = 0;
    const cloud = this.storage;
    const exec = (sql: string, ...bindings: unknown[]) => {
      if (this.#fault > 0 && !/^(SAVEPOINT|RELEASE|ROLLBACK)/.test(sql)) {
        this.#fault -= 1;
        if (this.#fault === 0) throw new InjectedFault(sql);
      }
      return cloud.sql.exec(sql, ...bindings);
    };
    const sql = { exec, databaseSize: 0 };
    const [tables, options] = this.#releases.deployed();
    const space = new Space({ ...cloud, sql }, tables, { ...options, commitFloor, pushRows });
    recordDecisions(cloud);
    return [space, new Server(this.#network.sockets(), space, chunkLimit)] as const;
  }

  /** 对象的存储出故障：在它之后执行的第 1 到 30 条读写语句 */
  fail() {
    this.#fault = 1 + Math.floor(this.#random() * 30);
  }

  /** 故障停止：不再出 */
  calm() {
    this.#fault = 0;
  }

  /** 直接调对象（服务端的写）：存储出了注入的故障就重置对象，返回 false */
  onObject(call: () => void) {
    try {
      call();
      return true;
    } catch (error) {
      if (!isInjected(error)) throw error;
      this.deploy();
      return false;
    }
  }

  /** 时间点恢复：整库回到当前时间线上更早的一版，对象重启，连接全断；返回恢复了没有（丢了写） */
  restore() {
    const version = this.#pick(this.history.earlier(head(this.storage).version));
    if (version === undefined) return false;
    this.#tracer?.add('Restore', undefined, { k: version });
    const before = this.storage;
    const pending = this.#rewound(before, version);
    this.storage = restoredStorage(this.history.rewind(version));
    this.revival.rewound(labelsIn(before), labelsIn(this.storage), pending);
    this.restores += 1;
    this.deploy(false);
    return true;
  }

  /** 下一次发布：备注表进入同步，或离开同步（模型的 Enter、Leave，都连带对象重启） */
  release() {
    this.#tracer?.add(this.#releases.cloudOnly() ? 'Enter' : 'Leave');
    this.#releases.next();
    this.deploy(false);
  }

  /** 部署协议版本是 version 的云端（入口 Worker 先认版本）：对象重启，全部连接断开；不给就在当前与上一个之间来回 */
  deployProtocol(version = this.#network.cloudVersion === protocolVersion ? protocolVersion - 1 : protocolVersion) {
    this.#network.cloudVersion = version;
    this.deploy();
  }

  /** 部署：对象重启，全部连接断开；traced 为假的是模型里别的动作连带的（恢复、发布） */
  deploy(traced = true) {
    if (traced) this.#tracer?.add('Deploy');
    this.#network.restart();
    [this.#space, this.server] = this.#serve();
  }

  /** 后台任务截日志的一步（模型的 Truncate）：截了就把新的下限记进轨迹；存储出了故障照常重置对象 */
  truncate() {
    const low = () => Number(this.storage.sql.exec('SELECT version FROM _syncline_low').toArray()[0]?.version ?? -1);
    const before = low();
    this.onObject(() => this.#space.truncate());
    if (low() === before) return;
    this.#tracer?.add('Truncate', undefined, { k: low() });
    this.history.reimage(this.storage);
  }

  /** 云端的性质：P1 每个客户端的每条写至多裁决一次；P8r 回滚掉、没有设备还留着的写不复活 */
  check() {
    const [twice] = decidedTwice(this.storage);
    if (twice) throw new Error(`写 ${twice} 被提交了两次`);
    this.revival.check(this.storage);
  }

  /** 服务端的写，经 Server.mutate 直接提交 */
  serverWrite(label: string) {
    // 出了故障：不知道提交没有（照 DO 文档），重试要能重做；这里不重试
    const before = head(this.storage).version;
    this.onObject(() => this.server.mutate((tx) => serverInc(tx, this.#pick(keys) as string, label)));
    if (head(this.storage).version !== before) this.#tracer?.add('BackendWrite');
  }
}
