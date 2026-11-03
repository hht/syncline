import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, expect, test } from 'vitest';
import { type Cookie, subprotocol } from '../common/protocol.ts';
import { pullURL } from '../common/pull-url.ts';
import { expiresHeader } from './forward.ts';
import { subHeader, subscriptionHeader } from './shared-forward.ts';
import { fannedOut } from './test-shared.ts';
import { inbox } from './test-socket.ts';

// 广播分片只接经入口转来的连接：入口总会带上到期时刻、订阅与订阅的指纹，缺了或是空的就不是经入口来的

afterAll(() => fannedOut('catalog'));

/** 直接对分片发 WebSocket 升级，headers 是入口该加的头；给出接没接受 */
async function accepted(headers: Record<string, string>) {
  const cookie: Cookie = { version: 0, nonce: 0 };
  try {
    const response = await env.CATALOG_BROADCAST.getByName(`catalog#${crypto.randomUUID()}`).fetch(
      pullURL('https://sync.test/catalog', { cookie }),
      { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': subprotocol, ...headers } },
    );
    response.webSocket?.accept();
    response.webSocket?.close();
    return response.status === 101;
  } catch {
    return false;
  }
}

/** 经入口的头直接连分片 shard，身份在 expiresAt 到期；按到达顺序取消息与关闭 */
async function connect(shard: DurableObjectStub, expiresAt: number) {
  const response = await shard.fetch(pullURL('https://sync.test/catalog', { cookie: { version: 0, nonce: 0 } }), {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': subprotocol, [expiresHeader]: String(expiresAt), ...subscription, ...sub },
  });
  if (!response.webSocket) throw new Error('没有升级成 WebSocket');
  return inbox(response.webSocket);
}

const expires = { [expiresHeader]: String(Date.now() + 60_000) };
const subscription = { [subscriptionHeader]: '["[\\"all\\"]"]' };
const sub = { [subHeader]: 'h' };

test('三个头都在：接受', async () => {
  expect(await accepted({ ...expires, ...subscription, ...sub })).toBe(true);
});

test('缺到期头、缺订阅的指纹头、到期头是空串：都不接受', async () => {
  const cases = {
    缺到期头: { ...subscription, ...sub },
    缺指纹头: { ...expires, ...subscription },
    到期头是空串: { [expiresHeader]: '', ...subscription, ...sub },
  };
  const outcomes = Object.fromEntries(
    await Promise.all(Object.entries(cases).map(async ([label, headers]) => [label, await accepted(headers)])),
  );
  expect(outcomes).toEqual({ 缺到期头: false, 缺指纹头: false, 到期头是空串: false });
});

test('身份到期、其间没有写：分片按 alarm 以 4001 关掉到期的连接，没到期的照常开着，alarm 改排到它到期的那一分钟', async () => {
  const shard = env.CATALOG_BROADCAST.getByName(`catalog#${crypto.randomUUID()}`);
  const later = Date.now() + 3_600_000;
  const soon = await connect(shard, Date.now() + 50);
  const kept = await connect(shard, later);
  expect(await soon()).toHaveProperty('message');
  expect(await kept()).toHaveProperty('message');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await runDurableObjectAlarm(shard)).toBe(true);
  expect(await soon()).toEqual({ close: 4001 });
  const open = await runInDurableObject(shard, (_, state) =>
    state.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN),
  );
  expect(open).toHaveLength(1);
  expect(await runInDurableObject(shard, (_, state) => state.storage.getAlarm())).toBe(Math.ceil(later / 60_000) * 60_000);
});
