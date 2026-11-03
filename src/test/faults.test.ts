import { expect, test } from 'vitest';
import { formatCookie } from '../common/protocol.ts';
import { Device, Space } from './test-checksum.ts';
import { head } from './test-commits.ts';
import { counter, keys, replay, type Snapshot, schema, serverInc, snapshot, tables, tag, writes } from './test-counter.ts';
import { random } from './test-random.ts';
import { write } from './test-schema.ts';
import { cloudStorage, deviceStorage, failOnce, faultable, isInjected } from './test-storage.ts';

// 设备在存储故障下（磁盘满、进程在两句之间被杀）：收下一块、一条通知或做一次本机写，要么整步生效、要么一点不留。
// 一个种子决定云端的写、本机写、分块拉取、推送与在第几句出错；每一步之后查 P5（本机 = 游标那一版的云端 + 重放待上传），
// 故障停止后拉完、推完，设备与云端一致

/** 一块很小：整份与增量都分好几块 */
const chunkLimit = 120;

/** 一个云端与一台存储会出错的设备，一个种子决定一切 */
class Faulty {
  readonly cloud = cloudStorage(...schema);
  readonly space = new Space(this.cloud, tables);
  readonly #faults = faultable(deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', ...schema));
  readonly device = new Device(this.#faults.storage, tables);
  readonly #pick: () => number;
  // 云端每个发出过的版本的快照，用来算设备应当看到什么
  readonly #history = new Map<string, Snapshot>([[formatCookie(head(this.cloud)), snapshot(this.cloud)]]);
  #labels = 0;

  constructor(seed: number) {
    this.#pick = random(seed);
  }

  choose<T>(items: T[]) {
    return items[Math.floor(this.#pick() * items.length)] as T;
  }

  label() {
    this.#labels += 1;
    return `t${this.#labels}`;
  }

  serverWrite() {
    this.space.mutate((tx) => serverInc(tx, this.choose(keys), this.label()));
    this.#record();
  }

  /** 设备做一步，有时在第几句出错；出的错只许是注入的（Drizzle 把驱动的错包一层，原来的错在 cause 里） */
  async attempt(step: () => Promise<unknown>) {
    if (this.#pick() < 0.4) this.#faults.arm(1 + Math.floor(this.#pick() * 30));
    try {
      await step();
    } catch (error) {
      if (!isInjected(error)) throw error;
    } finally {
      this.#faults.disarm();
    }
  }

  pull() {
    return this.device.private.receive(this.space.pull(this.device.private.pullRequest(), chunkLimit));
  }

  async push() {
    const poke = this.space.push(this.device.private.pending(), chunkLimit);
    this.#record();
    if (poke && 'patch' in poke) await this.device.private.receive(poke);
  }

  /** P5：本机 = 游标那一版的云端 + 重放待上传 */
  check() {
    const cookie = this.device.private.cookie();
    const base = cookie ? this.#history.get(formatCookie(cookie)) : { counter: [], tag: [] };
    if (!base) throw new Error('设备的游标不是云端发出过的版本');
    expect(snapshot(this.#faults.storage)).toEqual(replay(base, this.device.private.pending()));
  }

  /** 拉到最新一版、推完了 */
  settled() {
    return (
      !this.device.private.staging() &&
      this.device.private.pending().length === 0 &&
      this.device.private.cookie()?.version === head(this.cloud).version
    );
  }

  converged() {
    return (
      this.device.private.pending().length === 0 && JSON.stringify(snapshot(this.#faults.storage)) === JSON.stringify(snapshot(this.cloud))
    );
  }

  #record() {
    this.#history.set(formatCookie(head(this.cloud)), snapshot(this.cloud));
  }
}

test.for(Array.from({ length: 100 }, (_, seed) => seed))(
  '种子 %i：存储随时出错，设备每一步要么整步生效、要么一点不留，之后照常收敛',
  async (seed) => {
    const run = new Faulty(seed);
    const { device } = run;
    for (let step = 0; step < 80; step += 1) {
      const action = run.choose(['server', 'inc', 'mark', 'remove', 'pull', 'pull', 'push'] as const);
      if (action === 'server') run.serverWrite();
      else if (action === 'pull') await run.attempt(() => run.pull());
      else if (action === 'push') await run.attempt(() => run.push());
      else await run.attempt(() => writes[action](device, run.choose(keys), run.label()));
      run.check();
    }
    // 故障停止：拉到最新一版、推完
    for (let round = 0; round < 200 && !run.settled(); round += 1) {
      if (device.private.staging() || device.private.cookie()?.version !== head(run.cloud).version) await run.pull();
      else await run.push();
      run.check();
    }
    expect(run.converged()).toBe(true);
    // 对校验和：拉一次带 checksum 的（云端当场算），再一段段算本机的与它比
    await device.private.receive(run.space.pull({ ...device.private.pullRequest(), checksum: '' }, chunkLimit));
    expect(await device.private.verify()).toBe(true);
  },
);

/**
 * 本机写提交那句（RELEASE）出错、事务还开着：这条写一点不留、不占序号，下一条照用这个序号，云端收到的序号连续、不跳不重。
 * 另一种结果（已被自动回滚：磁盘满、I/O 错）注入造不出，还没有测试守着
 * @see https://sqlite.org/lang_transaction.html（Response To Errors Within A Transaction）
 */
test('本机写提交那句出错（事务还开着）：这条写一点不留、不占序号，之后的写照常推上去', async () => {
  const storage = deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', ...schema);
  failOnce(storage, 'RELEASE syncline_write');
  const device = new Device(storage, tables);
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, tables);
  await expect(writes.inc(device, 'a', 't1')).rejects.toThrow();
  expect(snapshot(storage)).toEqual({ counter: [], tag: [] });
  await writes.inc(device, 'a', 't2');
  await writes.inc(device, 'a', 't3');
  expect(device.private.pending().map(({ id }) => id)).toEqual([1, 2]);
  space.push(device.private.pending(), chunkLimit);
  expect(snapshot(cloud)).toEqual(snapshot(storage));
  expect(snapshot(cloud).counter).toEqual([{ id: 'a', n: 2 }]);
});

test('Syncline 自己的事务（收下云端的改动）提交那句出错、事务还开着：这次收下一点不留、事务结束，之后的本机写照常提交，重收照常', async () => {
  const storage = deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', ...schema);
  const device = new Device(storage, tables);
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, tables);
  space.mutate((tx) => serverInc(tx, 'a', 't1'));
  const pull = () => device.private.receive(space.pull(device.private.pullRequest(), chunkLimit));
  failOnce(storage, 'RELEASE syncline');
  await expect(pull()).rejects.toThrow();
  expect(storage.inTransaction()).toBe(false);
  expect(snapshot(storage)).toEqual({ counter: [], tag: [] });
  await writes.inc(device, 'b', 't2');
  expect(storage.inTransaction()).toBe(false);
  await pull();
  space.push(device.private.pending(), chunkLimit);
  expect(snapshot(storage)).toEqual(snapshot(cloud));
});

test('设备的磁盘满了（SQLITE_FULL，SQLite 自动回滚了整个事务）：本机写抛出的是磁盘满，不是回滚时找不到保存点；腾出地方后照常写', async () => {
  const storage = deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', ...schema);
  const device = new Device(storage, tables);
  const used = storage.sql.exec('PRAGMA page_count').toArray()[0]?.page_count;
  storage.sql.exec(`PRAGMA max_page_count = ${used}`);
  // 一次写约 200 KB：400 个标签，主键各约 500 字符（主键至多 512 字节，keyBytes）
  const big = () =>
    write(device, async (tx) => {
      await tx.insert(counter).values({ id: 'a', n: 1 }).onConflictDoNothing();
      for (let index = 0; index < 400; index += 1) await tx.insert(tag).values({ id: `t${index}`.padEnd(490, 'x'), counter_id: 'a' });
    });
  // Drizzle 把驱动的错包一层，原来的错在 cause 里
  await expect(big()).rejects.toMatchObject({ cause: { message: expect.stringMatching(/full/) } });
  storage.sql.exec('PRAGMA max_page_count = 1073741823');
  await big();
  expect(device.private.pending()).toHaveLength(1);
});
