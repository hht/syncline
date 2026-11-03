import { exports } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { pullBytes } from '../common/limits.ts';
import { bearer, subprotocol } from '../common/protocol.ts';
import { pullURL } from '../common/pull-url.ts';
import { protocolVersion, versionMismatch } from '../common/version.ts';
import { schemaPrefix } from '../tables/declaration.ts';
import { forward } from './forward.ts';
import { pullResponse, recording, space, url } from './test-space.ts';

// 入口 Worker 的 forward：先认协议版本、再认 token，认出的转给它的空间，不带 token 进去

test('没带 token、认不出的 token：WebSocket 与 HTTP 拉取都回 401', async () => {
  const requests: RequestInit[] = [
    { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': subprotocol } },
    { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}nobody` } },
    {},
    { headers: { Authorization: 'Bearer nobody' } },
  ];
  for (const init of requests) expect((await exports.default.fetch(pullURL(url, { cookie: null }), init)).status).toBe(401);
});

test('协议版本对不上（不同或没带）：先于认 token，HTTP 拉取回 409、正文是云端的版本；WebSocket 接受后以 4002 关闭、原因是云端的版本', async () => {
  for (const target of [`${url}?v=${protocolVersion + 1}`, url]) {
    const pulled = await exports.default.fetch(target, { headers: { Authorization: 'Bearer nobody' } });
    expect(pulled.status).toBe(409);
    expect(await pulled.text()).toBe(String(protocolVersion));
    const { webSocket: socket } = await exports.default.fetch(target, {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}nobody` },
    });
    if (!socket) throw new Error('没有升级成 WebSocket');
    const closed = new Promise((resolve) => socket.addEventListener('close', ({ code, reason }) => resolve({ code, reason })));
    socket.accept();
    expect(await closed).toEqual({ code: versionMismatch, reason: String(protocolVersion) });
  }
});

test('入口转给私有空间的请求不带 token：Authorization、子协议里的 token 去掉（对象用不着，免得进对象里的日志与报错）', async () => {
  const { seen, target } = recording();
  const namespace = { getByName: () => target };
  await forward(
    new Request(pullURL(url, { cookie: null }), { headers: { Authorization: 'Bearer secret' } }),
    namespace as never,
    async () => ({
      space: 's1',
      expiresAt: Number.MAX_SAFE_INTEGER,
    }),
  );
  expect(seen[0]?.headers.get('Authorization')).toBeNull();
  // WebSocket：子协议里的 token 去掉，只留协议名与别的子协议
  await forward(
    new Request(pullURL(url, { cookie: null }), {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}secret, ${schemaPrefix}e30` },
    }),
    namespace as never,
    async () => ({ space: 's1', expiresAt: Number.MAX_SAFE_INTEGER }),
  );
  expect(seen[1]?.headers.get('Sec-WebSocket-Protocol')).toBe(`${subprotocol}, ${schemaPrefix}e30`);
});

test('伪造的网址参数（多余的参数、私有空间正文里的项放进网址、游标认不出）：HTTP 拉取与 WebSocket 入口都回 400，不转给私有空间', async () => {
  const forwarded: Request[] = [];
  const namespace = {
    getByName: () => ({
      fetch: async (request: Request) => {
        forwarded.push(request);
        return new Response('{}');
      },
    }),
  };
  const pull = new URL(pullURL(url, { cookie: null }));
  for (const [name, value] of [
    ['extra', '1'],
    ['range', 'not json'],
    ['earliest', 'c1.0'],
    ['checksumRows', '0'],
    ['cookie', 'nonsense'],
  ]) {
    const target = new URL(pull);
    target.searchParams.append(name as string, value as string);
    for (const headers of [
      { Authorization: 'Bearer t' },
      { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}t` },
    ]) {
      const response = await forward(new Request(target, { headers }), namespace as never, async () => ({
        space: 's1',
        expiresAt: Number.MAX_SAFE_INTEGER,
      }));
      expect(response.status, `${name} ${headers.Upgrade ?? 'http'}`).toBe(400);
    }
  }
  expect(forwarded).toEqual([]);
});

test('接入方的 verify 给 null（纯 JS 写的）：一样回 401，不转给私有空间', async () => {
  const namespace = { getByName: () => ({ fetch: async () => new Response('{}') }) };
  const request = new Request(pullURL(url, { cookie: null }), { headers: { Authorization: 'Bearer t' } });
  const response = await forward(request, namespace as never, async () => null as never);
  expect(response.status).toBe(401);
});

test('HTTP 拉取是 POST、请求在正文里：正文认不出回 400、GET 回 405；正文列出 2 万个客户端照常拉（网址只有版本）', async () => {
  const name = space();
  const headers = { Authorization: `Bearer ${name}.${Number.MAX_SAFE_INTEGER}` };
  for (const body of ['not json', '{}', '{"cookie":null,"extra":1}'])
    expect((await exports.default.fetch(pullURL(url), { method: 'POST', body, headers })).status, body).toBe(400);
  expect((await exports.default.fetch(pullURL(url), { headers })).status).toBe(405);
  const clients = Array.from({ length: 20_000 }, () => crypto.randomUUID());
  const response = await pullResponse(
    name,
    null,
    undefined,
    {},
    { clients, earliest: Object.fromEntries(clients.map((client) => [client, 1])) },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ lmids: {} });
});

test('HTTP 拉取的正文超过 pullBytes（按 UTF-8 字节）：不读完、回 413，不拉取；正好 pullBytes 的照常拉', async () => {
  const name = space();
  const headers = { Authorization: `Bearer ${name}.${Number.MAX_SAFE_INTEGER}` };
  // 认得出的正文（列出一个名字很长的客户端），只是太大
  const shell = '{"cookie":null,"clients":[""]}';
  const padded = (name: string) => shell.replace('""', `"${name}"`);
  const pull = (body: string) => exports.default.fetch(pullURL(url), { method: 'POST', body, headers });
  expect((await pull(padded('x'.repeat(pullBytes + 1 - shell.length)))).status).toBe(413);
  expect((await pull(padded('x'.repeat(pullBytes - shell.length)))).status).toBe(200);
  // 字符数在上限内、UTF-8 字节数超了（é 占 2 字节）
  expect((await pull(padded('é'.repeat(pullBytes / 2)))).status).toBe(413);
});
