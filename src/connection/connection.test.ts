import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { Space } from '../cloud/space.ts';
import { receiveTimeout } from '../expo/shell.ts';
import { type ConnectionOptions, Device } from '../test/test-device.ts';
import { flush } from '../test/test-drive.ts';
import { captureReported } from '../test/test-errors.ts';
import { serving, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';
import { heartbeat } from './test-connection.ts';

// 连接的生命周期：stop 之后回来的不再算数，同步地址与连接网址的约束，取 token、建连接、拉取出错时按退避重来

const note = sqliteTable('note', { id: text().primaryKey() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY)';
const tables = [note];
const url = 'https://sync.test/space';

/** 一台设备连着一个空间：token 由测试决定何时给出，WebSocket 留一份好在关闭之后再触发它的回调 */
function connected() {
  const { network } = serving(new Space(cloudStorage(createNote), tables));
  const device = new Device(deviceStorage(createNote), tables);
  const tokens: ((token: string) => void)[] = [];
  const sockets: WebSocket[] = [];
  const addresses: string[] = [];
  const options = network.options(0);
  const connection = new Connection(device.private, {
    url,
    ...options,
    token: () => new Promise((resolve) => tokens.push(resolve)),
    socket: (address, protocols) => {
      const socket = options.socket(address, protocols);
      sockets.push(socket);
      addresses.push(address);
      return socket;
    },
  });
  /** 开始同步：给 token，HTTP 拉取的回应送到 */
  const startAndPull = async () => {
    connection.start();
    tokens[0]?.('valid');
    await flush();
    network.respond();
    network.arrive();
    await flush();
  };
  return { network, device, tokens, sockets, addresses, connection, startAndPull };
}

test('stop 之后回来的不再算数：等 token 时停的不再发拉取，拉取在路上时停的，应答到了也不落进本机库', async () => {
  const waiting = connected();
  waiting.connection.start();
  waiting.connection.stop();
  waiting.tokens[0]?.('valid');
  await flush();
  expect(waiting.network.pending()).toEqual([]);

  const pulling = connected();
  pulling.connection.start();
  pulling.tokens[0]?.('valid');
  await flush();
  expect(pulling.network.pending()).toHaveLength(1);
  pulling.connection.stop();
  pulling.network.respond();
  pulling.network.arrive();
  await flush();
  expect(pulling.device.private.cookie()).toBeNull();
});

test('连 WebSocket 的地址只带协议版本与游标，不列客户端：不随启动次数涨（补齐按游标确认）', async () => {
  const { device, addresses, connection, startAndPull } = connected();
  await write(device, (tx) => tx.insert(note).values({ id: 'n1' }));
  await startAndPull();
  expect(addresses).toHaveLength(1);
  expect([...new URL(addresses[0] as string).searchParams.keys()]).toEqual(['v', 'cookie']);
  connection.stop();
});

test('stop 之后回来的不再算数：关掉的连接上之后还派发 open 与消息，接得上的通知也不应用', async () => {
  const { network, device, sockets, connection, startAndPull } = connected();
  await startAndPull();
  network.handshake();
  network.deliver();
  const cookie = device.private.cookie();
  expect(cookie).not.toBeNull();
  await write(device, (tx) => tx.insert(note).values({ id: 'n1' }));
  connection.stop();
  const [socket] = sockets;
  socket?.onopen?.(new Event('open'));
  const poke = { base: cookie, cookie: { version: Number(cookie?.version) + 1, nonce: 1 }, lmids: {}, patch: [] };
  socket?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(poke) }));
  await flush();
  expect(device.private.cookie()).toEqual(cookie);
});

test('同步地址带查询串或 #：打开时就抛错（云端认不出拉取里别的参数，每次都会被拒）', () => {
  const device = new Device(deviceStorage(createNote), tables);
  for (const address of [`${url}?region=eu`, `${url}#x`])
    expect(() => new Connection(device.private, { url: address, token: async () => 't' })).toThrow('不能带查询串');
});

test('默认按全局的 fetch 拉取，不带 this 调用：浏览器的 fetch 在 this 不是全局对象时抛 Illegal invocation', async () => {
  const calls: unknown[] = [];
  vi.stubGlobal('fetch', function (this: unknown) {
    calls.push(this);
    return Promise.resolve(new Response(null, { status: 503 }));
  });
  try {
    const device = new Device(deviceStorage(createNote), tables);
    const connection = new Connection(device.private, { url, token: async () => 'valid', socket: () => ({}) as WebSocket });
    connection.start();
    await flush();
    connection.stop();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

/**
 * 开始一个只走 HTTP 拉取的连接（WebSocket 一直连不上），等第一次拉取走完：拉取的应答与计时由测试给，
 * 测试只记重连的计时（拉取的超时计时 receiveTimeout 不算）
 */
async function pulled(fetch: NonNullable<ConnectionOptions['fetch']>, schedule: NonNullable<ConnectionOptions['schedule']>) {
  const device = new Device(deviceStorage(createNote), tables);
  const connection = new Connection(device.private, { url, token: async () => 'valid', socket: () => ({}) as WebSocket, fetch, schedule });
  connection.start();
  for (let step = 0; step < 10; step += 1) await flush();
  return connection;
}

test('HTTP 拉到接不上本机游标的结果：记成下载出错、按退避再拉，不立刻重拉', async () => {
  const fetched: string[] = [];
  const timers: (() => void)[] = [];
  const unrelated = JSON.stringify({ base: { version: 9, nonce: 9 }, cookie: { version: 10, nonce: 1 }, lmids: {}, patch: [] });
  const connection = await pulled(
    async (url) => {
      fetched.push(url);
      return new Response(unrelated);
    },
    (run, delay) => {
      if (delay !== receiveTimeout) timers.push(run);
      return () => undefined;
    },
  );
  expect(fetched).toHaveLength(1);
  expect(connection.status().downloadError).toEqual(new Error('拉取的结果接不上本机游标'));
  expect(timers).toHaveLength(1);
  timers[0]?.();
  for (let step = 0; step < 10; step += 1) await flush();
  expect(fetched).toHaveLength(2);
  connection.stop();
});

test('拉取出错、正按退避等着时停下：撤掉这个计时，不留着睡完再拉', async () => {
  const timers: { delay: number; cancelled: boolean }[] = [];
  const connection = await pulled(
    async () => new Response('云端出错', { status: 500 }),
    (_, delay) => {
      if (delay === receiveTimeout) return () => undefined;
      const timer = { delay, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  );
  expect(connection.status().downloadError?.message).toContain('500');
  expect(timers.filter(({ cancelled }) => !cancelled)).toHaveLength(1);
  connection.stop();
  await flush();
  expect(timers.filter(({ cancelled }) => !cancelled)).toEqual([]);
});

test('接入方的 token() 一直不返回：30 秒后当作取不到，按退避重来，不一直等', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let calls = 0;
    const { connection } = await heartbeat({
      token: () => {
        calls += 1;
        return new Promise<string>(() => undefined);
      },
    });
    expect(calls).toBe(1);
    vi.advanceTimersByTime(receiveTimeout);
    await flush();
    expect(connection.status().downloadError?.message).toContain('取 token 超时');
    vi.runOnlyPendingTimers();
    await flush();
    expect(calls).toBe(2);
    connection.stop();
  } finally {
    vi.useRealTimers();
  }
});

test('token() 同步抛错、建 WebSocket 时抛错：都记成出错、按退避重来，不留下没人接的拒绝、不就此停住；建不出连接照常报出', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const reported = captureReported();
  try {
    const thrown = await heartbeat({
      token: () => {
        throw new Error('取不到登录态');
      },
    });
    await flush();
    expect(thrown.connection.status().downloadError?.message).toBe('取不到登录态');
    thrown.connection.stop();

    let attempts = 0;
    const broken = await heartbeat({
      beforeSocket: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('网址不对');
      },
    });
    await flush();
    expect(broken.connection.status().downloadError?.message).toBe('网址不对');
    vi.runOnlyPendingTimers();
    await flush();
    expect(broken.sockets).toHaveLength(1);
    expect(reported).toEqual(['网址不对']);
    broken.connection.stop();
  } finally {
    vi.useRealTimers();
  }
});

test('拉取的结果排在开着的本机写后面时停了、库随即关掉：不当作出错报出', async () => {
  const reported = captureReported();
  const { network, device, tokens, connection } = connected();
  connection.start();
  tokens[0]?.('valid');
  await flush();
  const { promise: gate, resolve } = Promise.withResolvers<void>();
  const open = write(device, () => gate);
  network.respond();
  network.arrive();
  await flush();
  connection.stop();
  device.close();
  resolve();
  await expect(open).rejects.toThrow('本机库已关闭');
  await flush();
  expect(reported).toEqual([]);
});
