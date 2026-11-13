import { exports } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { pullBytes } from '../../src/cloud/limits.ts';
import { forward } from '../../src/cloudflare/forward.ts';
import { bearer, subprotocol } from '../../src/protocol/messages.ts';
import { pullURL } from '../../src/protocol/pull-url.ts';
import { protocolVersion, versionMismatch } from '../../src/protocol/version.ts';
import { schemaPrefix } from '../../src/tables/declaration.ts';
import { pullResponse, recording, space, url } from '../worker/test-space.ts';

// Entry Worker forward: verifies protocol version, validates token, and forwards authenticated requests stripped of tokens.

test('returns 401 for missing, undecodable, or unrecognized tokens on WebSocket and HTTP pulls', async () => {
  const requests: RequestInit[] = [
    { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': subprotocol } },
    { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}nobody` } },
    // Not valid percent-encoding: no token can be decoded from it.
    { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}%E0%A4` } },
    {},
    { headers: { Authorization: 'Bearer nobody' } },
  ];
  for (const init of requests) expect((await exports.default.fetch(pullURL(url, { cookie: null }), init)).status).toBe(401);
});

test('rejects mismatched protocol versions with 409 for HTTP and 4002 for WebSocket before token verification', async () => {
  for (const target of [`${url}?v=${protocolVersion + 1}`, url]) {
    const pulled = await exports.default.fetch(target, { headers: { Authorization: 'Bearer nobody' } });
    expect(pulled.status).toBe(409);
    expect(await pulled.text()).toBe(String(protocolVersion));
    const { webSocket: socket } = await exports.default.fetch(target, {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}nobody` },
    });
    if (!socket) throw new Error('Expected WebSocket upgrade response');
    const closed = new Promise((resolve) => socket.addEventListener('close', ({ code, reason }) => resolve({ code, reason })));
    socket.accept();
    expect(await closed).toEqual({ code: versionMismatch, reason: String(protocolVersion) });
  }
});

test('strips tokens from Authorization headers and WebSocket subprotocols before forwarding to private space', async () => {
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
  // WebSocket: strips token from subprotocols, preserving protocol name and remaining subprotocols.
  await forward(
    new Request(pullURL(url, { cookie: null }), {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}secret, ${schemaPrefix}e30` },
    }),
    namespace as never,
    async () => ({ space: 's1', expiresAt: Number.MAX_SAFE_INTEGER }),
  );
  expect(seen[1]?.headers.get('Sec-WebSocket-Protocol')).toBe(`${subprotocol}, ${schemaPrefix}e30`);
});

test('returns 400 without forwarding to private space on malformed or spurious query parameters', async () => {
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

test('returns 401 without forwarding when verify callback resolves to null', async () => {
  const namespace = { getByName: () => ({ fetch: async () => new Response('{}') }) };
  const request = new Request(pullURL(url, { cookie: null }), { headers: { Authorization: 'Bearer t' } });
  const response = await forward(request, namespace as never, async () => null as never);
  expect(response.status).toBe(401);
});

test('handles POST HTTP pull requests: 400 on malformed or missing bodies, 405 on GET, and supports 20000 clients in body', async () => {
  const name = space();
  const headers = { Authorization: `Bearer ${name}.${Number.MAX_SAFE_INTEGER}` };
  for (const body of ['not json', '{}', '{"cookie":null,"extra":1}'])
    expect((await exports.default.fetch(pullURL(url), { method: 'POST', body, headers })).status, body).toBe(400);
  expect((await exports.default.fetch(pullURL(url), { method: 'POST', headers })).status, 'no body').toBe(400);
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

test('returns 413 without pulling when POST body exceeds pullBytes in UTF-8 bytes and serves requests at exact limit', async () => {
  const name = space();
  const headers = { Authorization: `Bearer ${name}.${Number.MAX_SAFE_INTEGER}` };
  // Well-formed body with oversized client payload exceeding pullBytes.
  const shell = '{"cookie":null,"clients":[""]}';
  const padded = (name: string) => shell.replace('""', `"${name}"`);
  const pull = (body: string) => exports.default.fetch(pullURL(url), { method: 'POST', body, headers });
  expect((await pull(padded('x'.repeat(pullBytes + 1 - shell.length)))).status).toBe(413);
  expect((await pull(padded('x'.repeat(pullBytes - shell.length)))).status).toBe(200);
  // Character count within limit while UTF-8 byte count exceeds budget (é is 2 bytes).
  expect((await pull(padded('é'.repeat(pullBytes / 2)))).status).toBe(413);
});

test('throws when verify returns a non-finite expiresAt (integrator error) instead of forwarding an unreadable expiry', async () => {
  const { target } = recording();
  for (const expiresAt of [Number.POSITIVE_INFINITY, Number.NaN])
    await expect(
      forward(
        new Request(pullURL(url, { cookie: null }), { headers: { Authorization: 'Bearer secret' } }),
        { getByName: () => target } as never,
        async () => ({ space: 's1', expiresAt }),
      ),
    ).rejects.toThrow('expiresAt must be a finite number');
});

test('decodes a percent-encoded token from the WebSocket subprotocol and forwards none of it', async () => {
  const { seen, target } = recording();
  const verified: string[] = [];
  await forward(
    new Request(pullURL(url, { cookie: null }), {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}std%2Fb64%2Bx%3D%2C%20y` },
    }),
    { getByName: () => target } as never,
    async (token) => {
      verified.push(token);
      return { space: 's1', expiresAt: Number.MAX_SAFE_INTEGER };
    },
  );
  expect(verified).toEqual(['std/b64+x=, y']);
  expect(seen[0]?.headers.get('Sec-WebSocket-Protocol')).toBe(subprotocol);
});

test('lets pages on any origin pull: answers the preflight, and every pull response, rejections included, allows any origin', async () => {
  const preflight = await exports.default.fetch(pullURL(url, { cookie: null }), {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.test',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type, syncline-schema',
    },
  });
  expect([preflight.status, ...['Origin', 'Headers'].map((name) => preflight.headers.get(`Access-Control-Allow-${name}`))]).toEqual([
    204,
    '*',
    'Authorization, Content-Type, Syncline-Schema',
  ]);
  // A real pull: the space's response has immutable headers, so allowing the origin must copy it.
  const pulled = await pullResponse(space(), null, undefined, { Origin: 'https://app.test' });
  const unknown = await exports.default.fetch(pullURL(url, { cookie: null }), { headers: { Origin: 'https://app.test' } });
  const outdated = await exports.default.fetch(url, { headers: { Origin: 'https://app.test' } });
  expect([pulled, unknown, outdated].map((response) => [response.status, response.headers.get('Access-Control-Allow-Origin')])).toEqual([
    [200, '*'],
    [401, '*'],
    [409, '*'],
  ]);
});
