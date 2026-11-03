import { join } from 'node:path';
import { expect } from 'vitest';
import { parsePoke } from '../common/parse.ts';
import { protocolVersion } from '../common/version.ts';
import { SimulatedCloud } from './test-cloud.ts';
import { decided, WriteLedger } from './test-commits.ts';
import { keys, labelsOf, Releases, writes } from './test-counter.ts';
import type { Device } from './test-device.ts';
import { SimulatedDevices } from './test-devices.ts';
import { flush } from './test-drive.ts';
import { privateCloud } from './test-entry.ts';
import { Network } from './test-network.ts';
import { random } from './test-random.ts';
import { garbled } from './test-requests.ts';
import { picker, settle, simulated, takeStep } from './test-skeleton.ts';
import { injectedPrefix } from './test-storage.ts';
import { Tracer } from './test-trace.ts';

// 确定性模拟：一个种子决定全部的写、收发次序、计时器与故障，失败时按测试名里的种子重跑即可复现（SIMULATION_SEED 换一段种子：
// 默认 0 起的 200 个，设成别的数就从它起，平时跑固定的，想多找问题时换着跑）。
// 跑的是真的 Server 与 Connection，只把 token、WebSocket、HTTP 与计时器换成由种子驱动的替身：
// token 有时取不到、认不出、连上就过期，有的会到期、设备照云端给的剩余时长续约；应答在云端算好之后才到设备，期间云端照常变；
// 在路上的应答与消息偶尔被改坏（设备照常报出、断开重来）；云端的协议版本偶尔回滚到上一个再部署回来；
// 对象的存储偶尔出错（平台随即重置对象，推了一半的一批里已提交的留着）。云端也随时有服务端的写（导入等），与设备的写交错。
// 消息上限调得很小：一次写的通知约 250 字符照常走 WebSocket，几条写的补齐常常太大、改走 HTTP，
// 整份与增量拉取都分好几块，块与块之间照样有写、断线与重启。
// 设备的写有加计数、打标签（计数同时被删时拒收）、删计数（连带删别的设备同时打的标签）。
// 断言的是 model 的性质，不看实现内部：P1 至多一次（云端的提交记录里每条写至多一条）、
// P5 设备看到的 = 游标那一版的云端 + 重放待上传（按参考实现算）、P7 已确认的不留在待上传、
// P8r 恢复回滚掉、没有设备还留着的写不复活、P8k 丢掉的只有恢复回滚掉的（裁决数 = 发起数 − 丢掉数）、P6/P9 故障停止后收敛；
// 另查模型当作前提的：一台设备同一时刻至多一条连接。
// 同步的范围随部署变（模型的 Enter、Leave，Releases），故障停止后设备都更新到最新的 App。
// 设备从系统备份恢复（可以恢复到另一台，即克隆）会丢掉备份之后的写，开着它的种子不查裁决数，只查收敛；
// 云端时间点恢复（可以不止一次）丢掉的写由 WriteLedger 数着，裁决数照样要对上。
// 共用空间另有模拟；一个私有空间的连接上限（32 条）要几十台设备，由平台测试守着
// @see https://apple.github.io/foundationdb/testing.html

class Simulation {
  /** 设备：进程、本机库与开着的写 */
  readonly #devices: SimulatedDevices;
  readonly #random: () => number;
  readonly #pick: ReturnType<typeof picker>;
  readonly #faults: { backups: boolean; restores: boolean };
  readonly #network: Network;
  /** 云端：对象与在它上面发生的事 */
  readonly #cloud: SimulatedCloud;
  /** 丢过写：设备从备份恢复。发起的写数不再等于裁决的写数 */
  lost = false;
  /** 云端恢复丢掉的写 */
  readonly #ledger = new WriteLedger();
  /** 设备上发起、改了东西的写数 */
  created = 0;
  #labels = 0;
  readonly releases = new Releases();
  /** 轨迹核对时记下每一步；不核对是 undefined */
  readonly #tracer: Tracer | undefined;
  /** 时间点恢复至多几次：模型只查 1 次（MaxRestores），轨迹核对时照它 */
  readonly #maxRestores: number;

  constructor(
    seed: number,
    { devices, tracer, ...faults }: { devices: number; backups: boolean; restores: boolean; tracer?: Tracer | undefined },
  ) {
    this.#random = random(seed);
    this.#pick = picker(this.#random);
    this.#tracer = tracer;
    this.#maxRestores = tracer ? 1 : 3;
    this.#network = new Network(
      (items) => this.#pick(items),
      () => privateCloud(this.#cloud.server),
      () => this.#cloud.deploy(),
    );
    this.#network.trace = tracer && ((...event) => this.#devices.traced(tracer, ...event));
    this.#cloud = new SimulatedCloud(this.#network, this.releases, tracer, this.#random, (before, at) => {
      this.#ledger.rewound(
        before,
        at,
        this.devices.map((_, index) => this.storage(index)),
      );
      return new Set([...this.devices.flatMap((device) => labelsOf(device.private.pending())), ...this.#devices.backupLabels()]);
    });
    this.#faults = faults;
    this.#devices = new SimulatedDevices(devices, this.#network, this.releases, tracer, this.#random);
    this.#tracer?.step('start');
  }

  /** 云端的库 */
  get cloud() {
    return this.#cloud.storage;
  }

  get devices() {
    return this.#devices.devices;
  }

  storage(index: number) {
    return this.#devices.storage(index);
  }

  /** 走一步：写、送达一帧或一次握手、HTTP 往返、到时的重连，或一次故障 */
  async step() {
    const device = Math.floor(this.#random() * this.devices.length);
    const actions: [number, () => unknown][] = [
      [16, () => this.#write(device, writes.inc)],
      [10, () => this.#write(device, writes.mark)],
      [4, () => this.#write(device, (on, id) => writes.remove(on, id))],
      [4, () => this.#openWrite(device)],
      [6, () => this.#devices.close(device)],
      [3, () => this.#cloud.serverWrite(this.#label())],
      [this.releases.notes(device) ? 6 : 0, () => this.#write(device, writes.note)],
      [this.releases.cloudOnly() ? 3 : 0, () => this.releases.cloudNote(this.cloud, this.#pick(keys) as string, this.#label())],
      [this.releases.more() ? 2 : 0, () => this.#cloud.release()],
      [80, () => this.#network.deliver()],
      [16, () => this.#network.handshake()],
      [12, () => this.#network.respond()],
      [12, () => this.#network.arrive()],
      [14, () => this.#network.fire()],
      [8, () => this.#network.breakOne()],
      [4, () => this.#network.silenceOne()],
      [4, () => this.#network.failOne()],
      [2, () => this.#network.garbleOne()],
      [2, () => this.#cloud.fail()],
      [4, () => this.#devices.start(device, 'Crash')],
      [4, () => this.#devices.background(device)],
      [2, () => this.#cloud.deploy()],
      [3, () => this.#cloud.truncate()],
      // 云端回滚到上一个协议版本、再部署回来：设备认出云端旧、照退避重连，不停下
      [1, () => this.#cloud.deployProtocol()],
      // 备份的是已提交的库：开着的本机写不在里面
      [this.#faults.backups && !this.#devices.opened(device) ? 3 : 0, () => this.#devices.backup(device)],
      [this.#faults.backups ? 3 : 0, () => this.#restoreDevice(device)],
      // 恢复可以不止一次（实现不限次数）
      [this.#faults.restores && this.#cloud.restores < this.#maxRestores ? 2 : 0, () => this.#cloud.restore()],
    ];
    await takeStep(this.#pick, actions, this.#tracer, () => this.#after());
  }

  /** 故障停止后收发到收敛；触发计时之前查一下待上传都在推 */
  async settle() {
    this.#tracer?.step('settle');
    await this.#stopFaults();
    await settle({
      network: this.#network,
      pick: this.#pick,
      tracer: this.#tracer,
      converged: () => this.#devices.converged(this.cloud),
      after: () => this.#after(),
      beforeFire: () => this.#devices.checkPushing(),
    });
  }

  /** 故障停止：存储不再出错，协议版本部署回来，关上开着的写，设备都更新到最新的 App */
  async #stopFaults() {
    this.#cloud.calm();
    if (this.#network.cloudVersion !== protocolVersion) this.#cloud.deployProtocol(protocolVersion);
    for (const index of this.#devices.openIndexes()) await this.#devices.close(index);
    for (const index of this.devices.keys()) if (this.releases.outdated(index)) this.#devices.start(index, 'Crash');
    // 关上开着的写后，排在它后面的收取接着做完（可能发出拉取），再看有没有事可做
    await this.#after();
  }

  async #after() {
    await flush();
    this.#tracer?.observe(
      this.devices,
      this.devices.map((_, index) => this.storage(index)),
      this.cloud,
    );
    this.#cloud.history.record(this.cloud);
    this.#ledger.observe(
      this.cloud,
      this.devices.map((_, index) => this.storage(index)),
    );
    for (const index of this.devices.keys()) {
      this.#check(index);
      // 一台设备同一时刻至多一条连接（模型的前提）
      if (this.#network.live(index) > 1) throw new Error(`设备 ${index} 同时开着 ${this.#network.live(index)} 条连接`);
    }
    this.#cloud.check();
    if (this.#network.ready().length === 0) this.#devices.checkPushing();
  }

  /** 从备份恢复到这台设备：丢了写 */
  #restoreDevice(index: number) {
    if (!this.#devices.restore(index)) return;
    this.lost = true;
    this.#ledger.restored(index);
  }

  /** 在一台设备上发起一条写，标签全局唯一 */
  async #write(index: number, write: (device: Device, id: string, label: string) => Promise<boolean>) {
    // 排在开着的本机写后面，要等它结束：这一步不等
    if (this.#devices.opened(index)) return;
    const label = this.#label();
    const device = this.devices[index] as Device;
    if (await write(device, this.#pick(keys) as string, label)) this.#written(index);
  }

  /** 设备上一条改了东西的写提交了 */
  #written(index: number) {
    this.created += 1;
    this.#tracer?.add('Mutate', index);
  }

  /** 在一台设备上发起一条一直开着的本机写：写完了、等关上才结束，其间收到的通知排在它后面；结束之前设备重启了（进程没了）就回滚了 */
  #openWrite(index: number) {
    const label = this.#label();
    this.#devices.open(index, this.#pick(keys) as string, label, () => this.#written(index));
  }

  #label() {
    this.#labels += 1;
    return `t${this.#labels}`;
  }

  /** P5、P7：设备看到的 = 游标那一版的云端 + 按参考实现重放待上传；待上传都还没被游标那一版裁决 */
  #check(index: number) {
    // 开着的本机写还没提交：库里看得到它写了一半，P5 等它结束再查
    if (this.#devices.opened(index)) return;
    const device = this.devices[index] as Device;
    this.#cloud.history.check(device.private.cookie(), device.private.pending(), this.storage(index));
  }

  /**
   * 收敛后对一轮校验和：一段段拉带 checksum 的（设备平时空闲、该对时才要），每段算本机的与它比，对上了接着下一段（库里记着从哪起），
   * 直到最后一段；对不上或作罢就停
   */
  async verify(index: number) {
    const device = this.devices[index] as Device;
    const next = () => this.storage(index).sql.exec("SELECT next FROM _syncline_verified WHERE space = ''").toArray()[0]?.next;
    for (let round = 0; round < 100; round += 1) {
      // 之前开始的一轮先做完（连接已作废的随之作罢）：不然这里会加入它、一起作罢，或它用掉这里收下的这段
      await this.#resume();
      const checksum = String(next() ?? '');
      await device.private.receive(parsePoke(this.#cloud.server.pull({ ...device.private.pullRequest(), checksum })));
      let done = false;
      const verified = device.private.verify().finally(() => {
        done = true;
      });
      await this.#resume(() => done);
      const matched = await verified;
      if (matched !== true || typeof next() !== 'string') return matched;
    }
    throw new Error('100 段还没对完一轮');
  }

  /**
   * 跑完替身网络上排着的 0 毫秒的计时，done 为真之前一直等着跑：Rust 的设备每批之间让出线程，排的是这种计时，
   * 与连接的计时一起在替身网络上
   */
  async #resume(done = () => true) {
    while (this.#network.fire(0) || !done()) await new Promise((resolve) => setImmediate(resolve));
  }

  /** 云端恢复丢掉的写有几条 */
  get rolledBack() {
    return this.#ledger.lost;
  }
}

/** 这段种子里开不开云端时间点恢复的（除以 4 余 2、3 的开着）：分在两个文件里并行跑 */
export function seeds(restores: boolean) {
  const first = Number(process.env.SIMULATION_SEED ?? 0);
  return Array.from({ length: 200 }, (_, index) => first + index).filter((seed) => seed % 4 >= 2 === restores);
}

/** 一个种子单独跑不到 1 秒，pnpm check 里各门禁并行、CPU 跑满时要 5 秒以上，默认的 5 秒不够 */
export const seedTimeout = { timeout: 30_000 };

/**
 * 跑一个种子：300 步，故障停止后收敛，查收敛后的性质。设了 SIMULATION_TRACE（一个目录）就记下轨迹，写到它下面以种子命名的目录里，
 * 交给 model/TracePrivate.tla 核对（pnpm model:trace）
 */
export async function simulate(seed: number) {
  const traces = process.env.SIMULATION_TRACE;
  const tracer = traces ? new Tracer() : undefined;
  const simulation = await simulated(
    // 奇数种子开着设备备份恢复
    () => new Simulation(seed, { devices: 3, backups: seed % 2 === 1, restores: seed % 4 >= 2, tracer }),
    () => {
      if (traces) tracer?.write(join(traces, String(seed)));
    },
    // 设备收到改坏的正文、云端拼通知时存储出的注入的故障照常报出；别的报出都是缺陷
    (message) => message.includes(garbled) || message.startsWith(injectedPrefix),
  );

  for (const [index, device] of simulation.devices.entries()) {
    const cloud = simulation.releases.view(simulation.cloud, index);
    expect(device.private.pending()).toEqual([]);
    expect([simulation.releases.view(simulation.storage(index), index), await simulation.verify(index)]).toEqual([cloud, true]);
  }
  // 设备发起的写都恰好被裁决一次（提交或拒收），云端恢复丢掉的除外；备份恢复丢的数不清，开着它的种子不查
  if (simulation.lost) return;
  expect(decided(simulation.cloud)).toBe(simulation.created - simulation.rolledBack);
}
