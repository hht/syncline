import { drizzle } from 'drizzle-orm/durable-sqlite';
import { expect } from 'vitest';
import { parseMessage, parsePoke } from '../common/parse.ts';
import type { Hint, Poke } from '../common/protocol.ts';
import { admin, createProgram, program, pullRest, viewer } from '../test/test-catalog.ts';
import { Device } from '../test/test-device.ts';
import { RecordingSocket } from '../test/test-sockets.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Broadcast } from './broadcast.ts';
import type { Event } from './events.ts';
import { Space } from './space.ts';

// 广播分片测试共用：一张计划表、公开与全部两条桶规则的共用空间，一个分片与一台同步过的设备，分片那一头的替身 WebSocket

export const rules = { public: { program: { where: "status = 'published'" } }, all: { program: {} } };
/** 看公开的与看全部的两种订阅 */
export const subscriptions = { public: viewer, admin };

/** 分片那一头：替身的连接表（分片重启后还在），问共用空间最新一版时记进 asked，failing 时出错（共用空间出错或过载） */
function shardSide(space: () => Space) {
  const accepted: RecordingSocket[] = [];
  const asked: string[] = [];
  const events: Event[] = [];
  const failing = { now: false };
  const sockets = { acceptWebSocket: (socket: RecordingSocket) => accepted.push(socket), getWebSockets: () => accepted };
  const latest = async () => {
    asked.push('latest');
    if (failing.now) throw new Error('共用空间出错');
    return space().round(64_000);
  };
  /** 分片（重新）启动：内存里知道的没了 */
  const start = () => new Broadcast(sockets, latest, (event) => events.push(event));
  return { asked, events, failing, start };
}

/** 共用空间、一个分片与一台同步过的设备；asked 记下设备同步之后分片向共用空间问了几次最新一版 */
export async function setup() {
  const cloud = cloudStorage(createProgram);
  let space = new Space(cloud, [program], { shared: { buckets: rules } });
  const { asked, events, failing, start } = shardSide(() => space);
  const run = { broadcast: start() };
  /** 后台写一个计划，把这一轮发给分片 */
  const commit = async (id: string, status = 'published') => {
    const { base } = space.mutate((tx) => tx.upsert(program, { id, status }));
    if (!base) throw new Error('应有 base');
    await run.broadcast.notify(space.round(64_000, base));
  };
  const storage = deviceStorage(createProgram);
  const catalog = new Device(storage, []).shared('catalog', [program]);
  /** 设备按公开的订阅拉到末块 */
  const pullAll = () => pullRest(catalog, space, (request) => space.pullShared(request, viewer));
  await commit('p1');
  await pullAll();
  asked.length = 0;
  /** 连上一条按 who 订阅的连接：设备订阅的是公开的；别的订阅的设备当作已追上最新一版 */
  const connect = async (who: keyof typeof subscriptions = 'public', expiresAt = Number.MAX_SAFE_INTEGER) => {
    const socket = new RecordingSocket();
    const cookie = who === 'public' ? catalog.cookie() : space.head();
    await run.broadcast.accept(socket, cookie, expiresAt, subscriptions[who]);
    return socket;
  };
  return {
    space: () => space,
    shard: () => run.broadcast,
    /** 分片重启（被驱逐、重置）：给出新的分片 */
    restart: () => Object.assign(run, { broadcast: start() }).broadcast,
    catalog,
    commit,
    connect,
    asked,
    events,
    programs: () => drizzle(storage).select().from(program).all(),
    pullAll,
    /** 共用空间的对象重启：部署改了桶规则（之后按新规则算） */
    redeploy: (changed: typeof rules) => (space = new Space(cloud, [program], { shared: { buckets: changed } })),
    /** 清空重建：新的空库（分片知道的还在） */
    rebuild: () => (space = new Space(cloudStorage(createProgram), [program], { shared: { buckets: rules } })),
    fail: (value: boolean) => Object.assign(failing, { now: value }),
  };
}

export const last = (socket: RecordingSocket) => parsePoke(socket.sent.at(-1) ?? '') as Poke;
/** 发给这条连接的最后一条是提示：给出它带的版本 */
export const hinted = (socket: RecordingSocket) => (parseMessage(socket.sent.at(-1) ?? '') as Hint).hint;

/** 设备收下这条连接上的最后一条（提示）、落后了去拉、拉到追上；之后的写照常推通知，接在设备的游标上 */
export async function catchesUp({ catalog, commit, pullAll }: Awaited<ReturnType<typeof setup>>, socket: RecordingSocket) {
  await catalog.notified(parseMessage(socket.sent.at(-1) ?? ''), false);
  expect(catalog.behind()).toBe(true);
  await pullAll();
  await commit('p3');
  expect(last(socket)).toMatchObject({ base: catalog.cookie(), patch: [{ row: { id: 'p3' } }] });
}
