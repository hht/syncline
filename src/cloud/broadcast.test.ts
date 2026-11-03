import { expect, test, vi } from 'vitest';
import { parseMessage, parsePoke } from '../common/parse.ts';
import { expired, socketLimit } from '../common/protocol.ts';
import { program } from '../test/test-catalog.ts';
import { captureReported } from '../test/test-errors.ts';
import { RecordingSocket } from '../test/test-sockets.ts';
import { catchesUp, hinted, last, rules, setup, subscriptions } from './test-broadcast.ts';

// 共用空间的广播分片（照 model/Fanout.tla）：连上先进推送名单再问最新一版补齐；每一轮按每条连接的订阅筛，接在推给它的上一版上，
// 与它的订阅无关的不推；接不上的一轮就问最新一版、给连接推提示

test('连上时游标就是最新一版：问到的正好是它，发一条空的补齐，带着这条连接的订阅，设备接得上', async () => {
  const { catalog, connect, asked } = await setup();
  const socket = await connect();
  expect(asked.length).toBeLessThanOrEqual(1);
  expect(last(socket)).toMatchObject({ cookie: catalog.cookie(), patch: [], sub: subscriptions.public.sub });
  expect(await catalog.receive(last(socket))).toBe(true);
});

test('每一轮按连接的订阅筛：设备收下就追上；出了订阅的桶的行给删除，看全部的照样收到它的新值', async () => {
  const { catalog, commit, connect, programs } = await setup();
  const socket = await connect();
  const admin = await connect('admin');
  await commit('p2');
  expect(await catalog.receive(last(socket))).toBe(true);
  await commit('p1', 'draft');
  expect(last(socket).patch).toEqual([{ op: 'del', table: 'program', key: { id: 'p1' } }]);
  expect(last(admin).patch).toEqual([{ op: 'put', table: 'program', key: { id: 'p1' }, row: { id: 'p1', status: 'draft' } }]);
  expect(await catalog.receive(last(socket))).toBe(true);
  expect(programs()).toEqual([{ id: 'p2', status: 'published' }]);
});

test('与订阅无关的一轮不推；之后有关的一轮接在推给它的上一版上推，设备照样接得上', async () => {
  const { catalog, commit, connect } = await setup();
  const socket = await connect();
  const sent = socket.sent.length;
  await commit('secret', 'draft');
  expect(socket.sent).toHaveLength(sent);
  await commit('p2');
  expect(last(socket)).toMatchObject({ base: catalog.cookie(), patch: [{ op: 'put', row: { id: 'p2' } }] });
  expect(await catalog.receive(last(socket))).toBe(true);
});

test('补齐：设备的游标比最新一版旧（设备落后了，哪怕正好是知道的那一轮的起点）发提示、不关连接，设备落后、连着去拉，拉完追上', async () => {
  const { space, catalog, commit, connect, events, pullAll, programs } = await setup();
  await commit('p2');
  await commit('p3');
  const behind = await connect();
  expect(behind.closed).toEqual([]);
  expect(hinted(behind)).toEqual(space().head());
  expect(events).toEqual([]);
  await catalog.notified(parseMessage(behind.sent.at(-1) ?? ''), false);
  expect(catalog.behind()).toBe(true);
  await pullAll();
  expect(catalog.behind()).toBe(false);
  expect(programs().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3']);
});

test('这一轮不带行（改到的太多）就给每条连接推提示、不关连接；身份到期的关掉；设备推写也关掉', async () => {
  const { space, shard, connect } = await setup();
  const viewer = await connect();
  const admin = await connect('admin');
  const { base } = space().mutate((tx) => tx.upsert(program, { id: 'p9', status: 'published' }));
  if (!base) throw new Error('应有 base');
  await shard().notify(space().round(10, base));
  expect(viewer.closed).toEqual([]);
  expect(hinted(viewer)).toEqual(space().head());
  expect(hinted(admin)).toEqual(space().head());
  expect(JSON.parse(viewer.sent.at(-1) ?? '{}')).toMatchObject({ sub: subscriptions.public.sub });

  const soon = await connect('admin', Date.now() + 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const again = space().head();
  space().mutate((tx) => tx.upsert(program, { id: 'p9', status: 'draft' }), 0);
  await shard().notify(space().round(64_000, again));
  expect(soon.closed).toEqual([expired]);
  expect(last(admin)).toMatchObject({ patch: [{ row: { id: 'p9' } }] });
  shard().receive(admin);
  expect(admin.closed).toEqual([1003]);
});

test('共用空间再发的、晚到的一轮（版本不比知道的新）不收：不推给设备，设备收到的都接得上', async () => {
  const { space, shard, catalog, commit, connect, programs } = await setup();
  const socket = await connect();
  const base = space().head();
  space().mutate((tx) => tx.upsert(program, { id: 'p2', status: 'published' }), 0);
  const late = space().round(64_000, base);
  await shard().notify(late);
  await commit('p3');
  const sent = socket.sent.length;
  await shard().notify(late);
  expect(socket.sent.length).toBe(sent);
  for (const message of socket.sent) expect(await catalog.receive(parsePoke(message))).toBe(true);
  expect(programs().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3']);
  const reconnected = await connect();
  expect(last(reconnected)).toMatchObject({ cookie: catalog.cookie(), patch: [] });
});

test('连接的订阅与设备落地的不同（换了令牌）：补齐带着这条连接的订阅，设备认出来、去拉，不应用按它算的通知', async () => {
  const { catalog, commit, connect, programs } = await setup();
  const socket = await connect('admin');
  expect(socket.closed).toEqual([]);
  expect(last(socket)).toMatchObject({ sub: subscriptions.admin.sub });
  expect(await catalog.notified(parseMessage(socket.sent.at(-1) ?? ''), false)).toBe(true);
  expect(catalog.behind()).toBe(true);
  await commit('p2');
  expect(await catalog.notified(parseMessage(socket.sent.at(-1) ?? ''), false)).toBe(true);
  expect(programs().map(({ id }) => id)).toEqual(['p1']);
});

test('部署改了桶规则：这一轮有一版不带键（这张表重扫），推提示；连着的与新连上的设备都去拉，拉取不重置', async () => {
  const { catalog, shard, connect, redeploy } = await setup();
  const socket = await connect();
  const before = catalog.cookie();
  if (!before) throw new Error('应同步过');
  const space = redeploy({ ...rules, public: { program: { where: "status != 'draft'" } } });
  expect(space.head().version).toBe(before.version + 1);
  await shard().notify(space.round(64_000, before));
  expect(hinted(socket)).toEqual(space.head());
  const late = await connect();
  expect(hinted(late)).toEqual(space.head());
  expect(await catalog.notified(parseMessage(late.sent.at(-1) ?? ''), false)).toBe(true);
  expect(catalog.behind()).toBe(true);
  expect(space.pullShared(catalog.pullRequest(), subscriptions.public)).not.toHaveProperty('reset');
});

test('分片重启后（内存里知道的没了）同时连上来的设备只问一次共用空间，都收到空的补齐', async () => {
  const { space, catalog, restart, connect, asked, pullAll } = await setup();
  space().mutate((tx) => tx.upsert(program, { id: 'p2', status: 'published' }), 0);
  await pullAll();
  restart();
  const sockets = await Promise.all([connect(), connect()]);
  expect(asked).toEqual(['latest']);
  for (const socket of sockets) expect(last(socket)).toMatchObject({ cookie: catalog.cookie(), patch: [] });
});

test('分片重启后收到的一轮接不上：问共用空间最新一版、记下，给推过的比它旧的连接推提示；之后的一轮接得上照常推通知', async () => {
  const run = await setup();
  const { space, commit, restart, connect, asked } = run;
  const socket = await connect();
  restart();
  await commit('p2');
  expect(asked).toContain('latest');
  expect(hinted(socket)).toEqual(space().head());
  await catchesUp(run, socket);
});

test('收到的一轮起点比知道的新（中间一轮没送到、共用空间的进度却前进了）：不按它推通知（会漏掉中间的改动），问最新一版、推提示', async () => {
  const { space, shard, catalog, connect, asked } = await setup();
  const socket = await connect();
  asked.length = 0;
  space().mutate((tx) => tx.upsert(program, { id: 'p2', status: 'published' }), 0);
  const base = space().head();
  space().mutate((tx) => tx.upsert(program, { id: 'p3', status: 'published' }), 0);
  await shard().notify(space().round(64_000, base));
  expect(asked).toEqual(['latest']);
  expect(hinted(socket)).toEqual(space().head());
  expect(await catalog.notified(parseMessage(socket.sent.at(-1) ?? ''), false)).toBe(true);
  expect(catalog.behind()).toBe(true);
});

test('收到一轮时正在问（新连接问的，问到的会比这一轮旧）：等它问完、不够新再问一次，记下并推的不比这一轮旧（不然这一轮确认了，连接却没听到）', async () => {
  const { space, shard, restart, connect, asked } = await setup();
  restart();
  const connecting = connect();
  const base = space().head();
  space().mutate((tx) => tx.upsert(program, { id: 'p2', status: 'published' }), 0);
  await shard().notify(space().round(64_000, base));
  const socket = await connecting;
  expect(asked).toEqual(['latest', 'latest']);
  expect(hinted(socket)).toEqual(space().head());
});

test('发一轮时有一条连接正在关（设备刚关、Close 帧还没到）：跳过它，不抛错，别的连接照常收到；再发同一版不会给设备重复推', async () => {
  const { commit, connect, space, shard } = await setup();
  const closing = await connect();
  const open = await connect();
  // 正在关的连接：往它 send 会抛错（workerd）
  closing.readyState = WebSocket.CLOSING;
  closing.send = () => {
    throw new TypeError("Can't call WebSocket send() after close().");
  };
  const before = space().head();
  await expect(commit('p2')).resolves.toBeUndefined();
  expect(last(open)).toMatchObject({ patch: [{ row: { id: 'p2' } }] });
  const received = open.sent.length;
  await shard().notify(space().round(64_000, before));
  expect(open.sent).toHaveLength(received);
});

test('连上时问共用空间失败（目录 DO 出错或过载）：不以 4000 关，也不发接在设备游标上的空补齐（之后的通知会漏掉中间的改动）；之后来的一轮推提示', async () => {
  const { catalog, commit, restart, connect, fail } = await setup();
  restart();
  fail(true);
  const reported = captureReported();
  const socket = await connect();
  expect(reported).toEqual(['共用空间出错']);
  expect(socket.closed).toEqual([]);
  expect(socket.sent).toEqual([]);
  fail(false);
  await commit('p2');
  expect(socket.sent).toHaveLength(1);
  expect(hinted(socket).version).toBeGreaterThan(catalog.cookie()?.version ?? 0);
  expect(reported).toEqual(['共用空间出错']);
});

test('连上时问共用空间失败、分片知道一轮：推它的提示（之后的通知接在它上面），设备去拉，不停在旧游标等下一次写', async () => {
  const run = await setup();
  const { space, commit, connect, fail } = run;
  await commit('p2');
  // 过了问询的最短间隔：再连上来要问
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_000);
  fail(true);
  const reported = captureReported();
  const socket = await connect();
  vi.useRealTimers();
  expect(reported).toEqual(['共用空间出错']);
  expect(hinted(socket)).toEqual(space().head());
  fail(false);
  await catchesUp(run, socket);
  expect(reported).toEqual(['共用空间出错']);
});

test('伪造很大的游标反复连上来：一段时间里最多问共用空间一次，连接照常接下', async () => {
  const { shard, asked } = await setup();
  const sockets: RecordingSocket[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const socket = new RecordingSocket();
    await shard().accept(socket, { version: Number.MAX_SAFE_INTEGER, nonce: 1 }, Number.MAX_SAFE_INTEGER, subscriptions.public);
    sockets.push(socket);
  }
  expect(asked.length).toBeLessThanOrEqual(1);
  for (const socket of sockets) expect(socket.closed).toEqual([]);
});

test('发给设备的消息带上重连的窗口（spread）：这片连着的设备数按每秒 500 台摊开要多久，部署断开全部连接时不挤在 1 秒内一齐重连', async () => {
  const { commit, connect } = await setup();
  const sockets = await Promise.all(Array.from({ length: 1200 }, () => connect()));
  expect(JSON.parse(sockets.at(-1)?.sent[0] ?? '{}')).toMatchObject({ spread: 2400 });
  await commit('p2');
  for (const socket of sockets) expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toMatchObject({ spread: 2400 });
});

test('筛出的改动在 WebSocket 一条消息的上限之内、包上别的字段超出：只推提示（与私有空间一样按整条消息的字节复核）', async () => {
  const { space, shard, connect } = await setup();
  const socket = await connect('admin');
  const base = space().head();
  space().mutate((tx) => tx.upsert(program, { id: 'p8', status: 'x'.repeat(socketLimit - 100) }));
  const round = space().round(64_000, base);
  expect(round.rows).toHaveLength(1);
  await shard().notify(round);
  expect(hinted(socket)).toEqual(round.cookie);
});

test('订阅相同、接在同一版上的设备多、通知大（字符数 × 连接数超过分片的内存预算）：只推提示，分片不为每条连接各存一份大通知', async () => {
  const { space, shard, connect } = await setup();
  const big = async (id: string) => {
    const base = space().head();
    // 一条通知接近 WebSocket 一条消息的上限（socketLimit）：700 条连接合计超过预算
    space().mutate((tx) => tx.upsert(program, { id, status: 'x'.repeat(23_000) }));
    await shard().notify(space().round(socketLimit * 2, base));
  };
  const one = await connect('admin');
  await big('p8');
  expect(last(one)).toMatchObject({ patch: [{ row: { id: 'p8' } }] });
  const many = [one, ...(await Promise.all(Array.from({ length: 699 }, () => connect('admin'))))];
  await big('p9');
  for (const socket of many) expect(hinted(socket)).toEqual(space().head());
});
