import { expect, test } from 'vitest';
import { Server } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import { type Mutation, pullNeeded } from '../common/protocol.ts';
import { AccountMismatch } from '../expo/errors.ts';
import { Device } from '../test/test-device.ts';
import { drain, flush, withFakeTimers } from '../test/test-drive.ts';
import { privateCloud } from '../test/test-entry.ts';
import { captureReported } from '../test/test-errors.ts';
import { type CloudEnd, Network } from '../test/test-network.ts';
import { write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';
import { heartbeat } from './test-connection.ts';
import { chunkLimit, createDraft, createNote, draft, expectConnected, idle, note, setup, url } from './test-status.ts';

// 同步状态：跟着连接、拉取、上传走，每次变了报给订阅者

test('状态跟着连接走：start 前都是假；整份拉取时在下载、带进度；连上补齐后已连上、同步过；每次变了都报给 onStatus', async () => {
  const { connection, seen, run } = setup();
  expect(connection.status()).toEqual(idle);
  connection.start();
  expect(connection.status()).toMatchObject({ connecting: true, connected: false });
  await run();

  expect(connection.status()).toEqual({ ...idle, connected: true, hasSynced: true });
  const progress = seen.flatMap(({ downloading, downloadProgress }) => (downloading && downloadProgress ? [downloadProgress] : []));
  expect(progress.length).toBeGreaterThan(0);
  for (const { downloaded, total } of progress) expect(downloaded > 0 && downloaded < total).toBe(true);
  expect(seen.at(-1)).toBe(connection.status());
  connection.stop();
  expect(connection.status()).toEqual({ ...idle, hasSynced: true });
});

test('HTTP 拉完了、WebSocket 还没连上（被代理挡住这类）：拉完那一刻就是同步过', async () => {
  const { network, connection } = setup();
  connection.start();
  await flush();
  for (let step = 0; step < 100 && connection.status().connecting; step += 1) {
    const kinds = network.ready().filter((kind) => kind !== 'handshake');
    if (kinds.length === 0) break;
    for (const kind of kinds) network[kind]();
    await flush();
  }
  expect(connection.status()).toMatchObject({ connected: false, downloading: false, hasSynced: true });
  connection.stop();
});

test('待上传：本机写之后加一，云端确认后清零', async () => {
  const { device, connection, run } = setup();
  connection.start();
  await run();
  await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
  expect(connection.status().pending).toBe(1);
  await run();
  expect(connection.status().pending).toBe(0);
  connection.stop();
});

test('取不到 token、连接断了记成下载出错，之后连上清掉', async () => {
  const { network, state, connection, run } = setup();
  state.tokenFails = true;
  connection.start();
  await flush();
  expect(connection.status()).toMatchObject({ connecting: true, downloadError: new Error('取不到 token') });

  state.tokenFails = false;
  network.fire();
  await run();
  expectConnected(connection);
  network.breakOne();
  expect(connection.status()).toMatchObject({ connected: false, connecting: true, downloadError: expect.any(Error) });
  network.fire();
  await run();
  expectConnected(connection);
  connection.stop();
});

test('云端执行不了的写扣下待修复：序号照样推进、待上传清掉，onHeld 给出原因与原样的改动；不算上传出错，sync() 照常成功', async () => {
  const { space, device, connection, serverErrors, run } = setup();
  connection.start();
  await run();
  const held: { reason: string }[] = [];
  device.onHeld((writes) => held.push(...writes));
  await write(device, (tx) => tx.insert(draft).values({ id: 'd1' }));
  const synced = connection.sync();
  await run();
  await synced;
  expect(serverErrors).toEqual([]);
  expect(held).toEqual([{ reason: expect.stringContaining('draft'), changes: [{ op: 'put', table: 'draft', row: { id: 'd1' } }] }]);
  expect(connection.status()).toMatchObject({ connected: true, pending: 0, uploadError: undefined });
  expect(space.held()).toMatchObject([{ id: 1, changes: [{ op: 'put', table: 'draft', row: { id: 'd1' } }] }]);
  connection.stop();
});

test('云端处理推送本身出错（存储出错这类，不是某条写执行不了）：以 1011 关掉，记成上传出错，正在等的 sync() 随之失败', async () => {
  const { space, device, connection, serverErrors, run, events } = setup();
  connection.start();
  await run();
  space.push = () => {
    throw new Error('存储出错');
  };
  await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
  const failed = connection.sync().catch((error: unknown) => error);
  await run(false);
  expect(serverErrors).toHaveLength(1);
  expect(connection.status()).toMatchObject({ connected: false, pending: 1, uploadError: expect.any(Error) });
  expect(await failed).toEqual(connection.status().uploadError);
  expect(events).toContainEqual({ type: 'push.failed', reason: '存储出错' });
  expect(events).toContainEqual({ type: 'connection.closed', code: 1011, reason: 'push failed' });
  connection.stop();
});

test('超过云端的写入额度：以 1013 关掉，记成上传出错（不是下载），写还在待上传、按退避重推', async () => {
  const { device, connection, run, events } = setup({ rate: 1e-9, burst: 1 });
  connection.start();
  await run();
  await write(device, (tx) => tx.insert(note).values({ id: 'q1' }));
  await run(false);
  await write(device, (tx) => tx.insert(note).values({ id: 'q2' }));
  const failed = connection.sync().catch((error: unknown) => error);
  await run(false);
  expect(events).toContainEqual({ type: 'connection.closed', code: 1013, reason: 'over quota' });
  expect(connection.status()).toMatchObject({ connected: false, pending: 1, uploadError: expect.any(Error), downloadError: undefined });
  expect(await failed).toEqual(connection.status().uploadError);
  connection.stop();
});

test('云端以 4000 关掉连接（游标不在当前历史上，要先拉取）：不立刻重连、不算失败，拉取（整份重拉）后再连上', async () => {
  const { cloud, network, connection, run, events } = setup();
  connection.start();
  await run();
  expect(connection.status()).toMatchObject({ connected: true });
  // 云端的历史换掉了（时间点恢复后又写了同样多版）：设备游标那一版的随机数对不上
  cloud.sql.exec('UPDATE _syncline_commit SET nonce = nonce + 1 WHERE version = (SELECT max(version) FROM _syncline_commit)');
  network.breakOne();
  await run();
  expect(events).toContainEqual({ type: 'connection.closed', code: pullNeeded, reason: 'not on history' });
  expectConnected(connection);
  connection.stop();
});

test('通知太大：云端只发提示、连接不断，设备连着 HTTP 拉到追上，不算失败、不重连', async () => {
  const { server, network, connection, run, events, notes } = setup();
  connection.start();
  await run();
  expect(connection.status()).toMatchObject({ connected: true });
  const accepted = network.accepted.size;
  server.mutate((tx) => {
    for (let n = 0; n < 10; n += 1) tx.insert(note, { id: `note-${'x'.repeat(30)}-${n}` });
  });
  await run();
  expect(events.filter(({ type }) => type === 'connection.closed')).toEqual([]);
  expect([network.accepted.size, notes()]).toEqual([
    accepted,
    expect.arrayContaining([expect.objectContaining({ id: expect.stringMatching(/^note-x/) })]),
  ]);
  expect(connection.status()).toMatchObject({ connected: true, downloading: false, downloadError: undefined });
  connection.stop();
});

test('前一批推送还没确认时又写了：不重发在路上的那批，确认到了再推下一批；每条写只推一次', async () => {
  const { server, device, connection, run } = setup();
  const pushed: string[] = [];
  const receive = server.receive.bind(server);
  server.receive = (socket, message) => {
    for (const { client, id } of JSON.parse(message) as { client: string; id: number }[]) pushed.push(`${client}/${id}`);
    receive(socket, message);
  };
  connection.start();
  await run();
  await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
  await write(device, (tx) => tx.insert(note).values({ id: 'n10' }));
  await run();
  expect(connection.status().pending).toBe(0);
  expect(pushed).toHaveLength(2);
  expect(new Set(pushed).size).toBe(2);
  connection.stop();
});

test('界面的监听器抛错：本机写照样成功、照样推送并被确认，别的监听器照样收到；错误照常报出（不吞）', async () => {
  const { device, connection, run } = setup();
  const reported = captureReported();
  try {
    connection.start();
    await run();
    device.onChange(() => {
      throw new Error('界面出错');
    });
    connection.onStatus(() => {
      throw new Error('状态出错');
    });
    await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
    await run();
    expect(connection.status().pending).toBe(0);
    expect(reported).toContain('界面出错');
    expect(reported).toContain('状态出错');
  } finally {
    connection.stop();
  }
});

test('云端认不出推上去的这批（设备的缺陷：解析不了、超出上限、认不出写的身份）：以 1007 关、报 push.failed；设备报 uploadError，这次不再推，下载照常；整份重下留着它还会被拒，丢掉待上传才照常推', async () => {
  const { device, connection, run, events, serverErrors, state } = setup();
  connection.start();
  await run();
  // 写 n9 的那条认不出是哪个客户端的：没法扣下、推进序号，整批拒收（只是改动认不出的那条，云端扣下它、不拒收整批）
  const broken = (mutation: Mutation) => JSON.stringify(mutation.changes).includes('"n9"');
  state.tamper = (mutation) => (broken(mutation) ? { ...mutation, client: 1 as never } : mutation);
  await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
  const reported = captureReported();
  await run();
  expect(events).toContainEqual({ type: 'connection.closed', code: 1007, reason: 'invalid push' });
  expect(reported).toHaveLength(1);
  expect(serverErrors).toEqual([]);
  const closed = events.filter(({ type }) => type === 'connection.closed').length;
  await run();
  expect(events.filter(({ type }) => type === 'connection.closed')).toHaveLength(closed);
  expect(connection.status()).toMatchObject({
    connected: true,
    pending: 1,
    uploadError: expect.objectContaining({ message: expect.stringContaining('认不出') }),
  });
  // 不再推、待上传永远不为 0：手动同步立刻带着上传的错失败，不一直等（等不到追平）
  const outcome = connection.sync().then(
    () => 'synced',
    (error: Error) => error.message,
  );
  await run();
  expect(await Promise.race([outcome, Promise.resolve('waiting')])).toContain('认不出');
  // 整份重下默认留着待上传：重新开始推，那批还会被拒，等着的随之失败
  await expect(Promise.all([connection.resync(), run()])).rejects.toThrow('认不出');
  expect(connection.status().pending).toBe(1);
  await Promise.all([connection.resync({ discardPending: true }), run()]);
  await write(device, (tx) => tx.insert(note).values({ id: 'n10' }));
  await run();
  expectConnected(connection, { pending: 0 });
  // 两次被拒各报一次（整份重下留着的那批又被拒了一次）
  expect(reported).toHaveLength(2);
  connection.stop();
});

test('待上传里夹着一条改动认不出的写（设备的缺陷、版本不符）：云端只扣下它，前后的写照常确认，不用清空重下，设备同步完、告诉接入方哪条被扣下', async () => {
  const { device, connection, run, space, notes, state } = setup();
  connection.start();
  await run();
  state.tamper = (mutation) => (mutation.id === 2 ? { ...mutation, changes: 'x' as never } : mutation);
  for (const id of ['g1', 'bad', 'g2']) await write(device, (tx) => tx.insert(note).values({ id }));
  const held: unknown[] = [];
  device.onHeld((writes) => held.push(...writes));
  await run();
  expectConnected(connection, { pending: 0 });
  expect(space.held()).toMatchObject([{ id: 2, changes: 'x' }]);
  expect(held).toEqual([
    { reason: expect.stringContaining('格式不对'), changes: [expect.objectContaining({ row: expect.objectContaining({ id: 'bad' }) })] },
  ]);
  expect(notes().map(({ id }) => id)).toEqual(expect.arrayContaining(['g1', 'g2']));
  expect(notes().map(({ id }) => id)).not.toContain('bad');
  connection.stop();
});

test('云端说的空间变了（这台设备上换了账号）：同步停下、报 AccountMismatch，不再重连，本机的数据与待上传都留着', async () => {
  const space = new Space(cloudStorage(createNote, createDraft), [note, draft]);
  space.mutate((tx) => tx.insert(note, { id: 'n1' }));
  let identity = 'alice';
  const network: Network = new Network(
    (items) => items[0],
    () => privateCloud(server, identity),
  );
  const server: Server<CloudEnd> = new Server(network.sockets(), space, chunkLimit);
  const device = new Device(deviceStorage(createNote, createDraft), [note, draft]);
  const connection = new Connection(device.private, { url, ...network.options(0) });
  const reported = captureReported();
  connection.start();
  await drain(network);
  expect(connection.status()).toMatchObject({ connected: true });
  identity = 'bob';
  network.breakOne();
  await drain(network);
  expect(connection.status()).toMatchObject({ connected: false, connecting: false, downloadError: expect.any(AccountMismatch) });
  expect(network.fire()).toBe(false);
  expect(device.private.cookie()).not.toBeNull();
  expect(reported).toHaveLength(1);
});

test('连接断了、对方给了原因（手机上连不上：解析地址、TLS、握手被拒都以 1006 带着原因交来）：下载出错的消息带着原因', () =>
  withFakeTimers(async () => {
    const { connection, sockets, open } = await heartbeat();
    open();
    sockets[0]?.socket.onclose?.(new CloseEvent('close', { code: 1006, reason: '证书不受信任' }));
    await flush();
    expect(connection.status().downloadError?.message).toBe('连接断了（关闭码 1006：证书不受信任）');
    connection.stop();
  }));
