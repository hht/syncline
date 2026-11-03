import { type Change, sameCookie } from '../common/protocol.ts';
import type { Storage } from '../common/storage.ts';
import { Device } from './test-checksum.ts';
import { head } from './test-commits.ts';
import { createMemo, labelsOf, type Releases, schema, writes } from './test-counter.ts';
import type { Network } from './test-network.ts';
import { started } from './test-skeleton.ts';
import type { Trace } from './test-sockets.ts';
import { deviceStorage, restoredDeviceStorage, restoredStorage } from './test-storage.ts';
import type { Connection } from './test-sync.ts';
import type { Message, Tracer } from './test-trace.ts';

// 确定性模拟里的设备：每台一个本机库、真的 Device 与 Connection；进程启动、崩溃重启、退到后台、
// 系统备份与从备份恢复，每台设备一直开着的那次本机写与排在它后面的消息；设备收敛了没有、连着时有没有停着不推。什么时候发生由模拟挑；它们在模型里的动作记进轨迹

const url = 'https://sync.test/space';

/** 每台设备一直开着的那次本机写（写完了、还没结束）：开着时收到的通知排在它后面 */
class OpenWrites {
  readonly #open = new Map<number, { close: () => void; done: Promise<unknown> }>();

  has(index: number) {
    return this.#open.has(index);
  }

  indexes() {
    return [...this.#open.keys()];
  }

  /** 在第 index 台设备上开一条加计数的写：写完了、等 close 才结束；结束时调 committed（关库回滚了就不调） */
  open(index: number, device: Device, id: string, label: string, committed: () => void) {
    if (this.#open.has(index)) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#open.set(index, { close: resolve, done: writes.inc(device, id, label, promise).then(committed, () => undefined) });
  }

  async close(index: number) {
    const open = this.#open.get(index);
    this.#open.delete(index);
    open?.close();
    await open?.done;
  }

  /** 设备进程没了：开着的写随关库回滚 */
  forget(index: number) {
    this.#open.delete(index);
  }
}

export class SimulatedDevices {
  readonly devices: Device[] = [];
  readonly #storages: ReturnType<typeof deviceStorage>[];
  readonly #connections: Connection[] = [];
  // 唯一的设备备份槽，照模型：再备份就覆盖
  #image: Uint8Array | undefined;
  readonly #open = new OpenWrites();
  /** 轨迹核对：每台设备排在开着的写后面、还没收下的消息 */
  readonly #deferred: { optional?: boolean; message?: Message }[][] = [];
  readonly #network: Network;
  readonly #releases: Releases;
  readonly #tracer: Tracer | undefined;
  readonly #random: () => number;

  /** count 台设备，都启动 */
  constructor(count: number, network: Network, releases: Releases, tracer: Tracer | undefined, random: () => number) {
    this.#network = network;
    this.#releases = releases;
    this.#tracer = tracer;
    this.#random = random;
    this.#storages = Array.from({ length: count }, () => deviceStorage(...schema, createMemo));
    for (const index of this.#storages.keys()) this.start(index);
  }

  /** 网络上的一件事记进轨迹：设备收下消息排在开着的本机写后面，写关上时才收，轨迹里记在那一步 */
  traced(tracer: Tracer, ...[name, index, options]: Parameters<Trace>) {
    // 云端发给设备的消息只给共用空间的轨迹用：私有空间模型里它们在云端那一步就放进了网络
    if (name === 'Sent') return;
    if (name === 'Recv' && this.#open.has(index)) this.#deferred[index] = [...(this.#deferred[index] ?? []), options ?? {}];
    else tracer.add(name, index, options);
  }

  storage(index: number) {
    return this.#storages[index] as Storage;
  }

  /** 连着云端（同步状态说的） */
  connected(index: number) {
    return this.#connections[index]?.status().connected === true;
  }

  /**
   * 启动一次：崩溃重启与从备份恢复后都是新的 Device 与 Connection；进程没了，它的连接与请求都断。
   * restart 是它在模型里对应的动作（第一次启动是模型的初始状态，没有）
   */
  start(index: number, restart?: 'Crash' | 'RestoreBackup') {
    if (restart) this.#tracer?.add(restart, index);
    this.#connections[index]?.stop();
    // 进程没了：开着的本机写回滚
    this.devices[index]?.close();
    this.#open.forget(index);
    this.#discardDeferred(index);
    this.#network.disconnect(index);
    const device = new Device(this.#storages[index] as ReturnType<typeof deviceStorage>, ...this.#releases.install(index));
    this.devices[index] = device;
    this.#connections[index] = started(device.private, url, this.#network, index, this.#random);
  }

  /** App 退到后台又回来：同一个 Connection 先 stop 再 start；stop 作废这次连接，排在开着的写后面的消息之后收下也不理 */
  background(index: number) {
    this.#connections[index]?.stop();
    this.#discardDeferred(index);
    this.#connections[index]?.start();
  }

  /**
   * 排在开着的写后面、还没收下的消息作废了（进程没了，或连接被 stop 作废、收下时不理）：模型里是丢了这些消息，要记在作废的这一步，
   * 之后的拉取才不会被模型当成上一次还在路上。连接上的通知与提示可以没有（模型里可能早已随连接断了不在，通知太大改发的提示模型里没有）
   */
  #discardDeferred(index: number) {
    for (const options of this.#deferred[index] ?? []) {
      const socket = options.message?.t === 'poke' || options.message?.t === 'hint';
      this.#tracer?.add('Drop', index, socket ? { ...options, optional: true } : options);
    }
    this.#deferred[index] = [];
  }

  /** 备份这台设备的库（唯一的备份槽，再备份就覆盖） */
  backup(index: number) {
    this.#image = this.#storages[index]?.image();
    this.#tracer?.add('Backup', index);
  }

  /** 备份里待上传打的标签（云端恢复时它们也算还留着：恢复到设备上就会再推） */
  backupLabels() {
    if (!this.#image) return [];
    const backup = restoredStorage(this.#image);
    return backup.sql
      .exec('SELECT changes FROM _syncline_pending')
      .toArray()
      .flatMap(({ changes }) => labelsOf([{ client: '', id: 0, changes: JSON.parse(String(changes)) as Change[] }]));
  }

  /** 从备份恢复到这台设备（备份来自别的设备时就是克隆）；没有备份返回 false */
  restore(index: number) {
    if (!this.#image) return false;
    this.#storages[index] = restoredDeviceStorage(this.#image);
    this.#image = undefined;
    this.start(index, 'RestoreBackup');
    return true;
  }

  /** 这台设备开着一次本机写；开着的是哪几台 */
  opened(index: number) {
    return this.#open.has(index);
  }

  openIndexes() {
    return this.#open.indexes();
  }

  /** 在一台设备上发起一条一直开着的本机写：写完了、等关上才结束，其间收到的通知排在它后面；结束之前设备重启了（进程没了）就回滚了 */
  open(index: number, id: string, label: string, written: () => void) {
    const device = this.devices[index] as Device;
    this.#open.open(index, device, id, label, () => this.devices[index] === device && written());
  }

  /** 关上一台设备上开着的写：排在它后面的消息随即收下 */
  async close(index: number) {
    const deferred = this.#deferred[index] ?? [];
    this.#deferred[index] = [];
    await this.#open.close(index);
    for (const options of deferred) this.#tracer?.add('Recv', index, options);
  }

  /** 推送不停住：网络上没事可做时，连着、追平了的设备不该还有待上传（不靠重连、心跳才推出去） */
  checkPushing() {
    for (const [index, device] of this.devices.entries()) {
      // 开着本机写的设备：收到的通知排在它后面，还没处理
      const connected = this.connected(index) && !this.#network.silent(index) && !this.#open.has(index);
      if (connected && !device.private.behind() && device.private.pending().length > 0)
        throw new Error(`设备 ${index} 连着却停着不推：还有 ${device.private.pending().length} 条待上传`);
    }
  }

  /** 收敛：没有待上传、不落后（该对校验和的也要过了），游标是云端最新的一版，与云端一致 */
  converged(cloud: Storage) {
    return this.devices.every(
      (device, index) =>
        device.private.pendingCount() === 0 &&
        !device.private.behind() &&
        sameCookie(device.private.cookie(), head(cloud)) &&
        this.#releases.same(index, this.storage(index), cloud),
    );
  }
}
