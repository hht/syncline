import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import { bearer, type Change, type Chunk, type Cookie, type Poke, subprotocol } from '../common/protocol.ts';
import { type PullRequest, pullBody, pullURL } from '../common/pull-url.ts';
import { inbox } from './test-socket.ts';

// 平台测试共用：经测试 Worker 的入口连私有空间的设备（WebSocket 与 HTTP 拉取）、设备 c1 的写

export const url = 'https://sync.test/space';

/** 每个测试一个新空间，用它的名字 */
export const space = () => crypto.randomUUID();
export const object = (name: string) => env.SPACE.getByName(name);

/**
 * 过了 ms 毫秒再跑一次 alarm：定时表里登记的都提前 ms（alarm 只做到时候了的，测试不真等），返回跑没跑（没排 alarm 是 false）
 * @see https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/（runDurableObjectAlarm）
 */
export async function alarmAfter(stub: DurableObjectStub, ms: number) {
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec('UPDATE _syncline_schedule SET at = at - ?', ms);
  });
  return runDurableObjectAlarm(stub);
}

/** 测试 Worker 认的 token：空间名.到期的毫秒数 */
const token = (name: string, expiresAt = Number.MAX_SAFE_INTEGER) => `${name}.${expiresAt}`;

/** 连上空间，按到达顺序取消息与关闭 */
export async function connect(
  name: string,
  cookie: Cookie | null,
  expiresAt?: number,
  headers: Record<string, string> = {},
  protocols: string[] = [],
) {
  const offered = [subprotocol, `${bearer}${token(name, expiresAt)}`, ...protocols].join(', ');
  const response = await exports.default.fetch(pullURL(url, { cookie }), {
    headers: { ...headers, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': offered },
  });
  const { webSocket: socket } = response;
  if (!socket) throw new Error('没有升级成 WebSocket');
  expect(response.headers.get('Sec-WebSocket-Protocol')).toBe(subprotocol);
  return {
    socket,
    next: inbox(socket),
    push: (...mutations: { id: number; changes: Change[] }[]) =>
      socket.send(JSON.stringify(mutations.map((mutation) => ({ client: 'c1', ...mutation })))),
  };
}

export async function pull(name: string, cookie: Cookie | null, cursor?: string) {
  return (await (await pullResponse(name, cookie, cursor)).json()) as Poke & Partial<Chunk>;
}

/** HTTP 拉取（POST，请求在正文里）的原样应答；request 是另带的请求项，headers 是另带的请求头 */
export function pullResponse(
  name: string,
  cookie: Cookie | null,
  cursor?: string,
  headers: Record<string, string> = {},
  request: Partial<PullRequest> = {},
) {
  return exports.default.fetch(pullURL(url), {
    method: 'POST',
    body: pullBody({ cookie, ...(cursor === undefined ? {} : { cursor }), ...request }),
    headers: { ...headers, Authorization: `Bearer ${token(name)}` },
  });
}

/** 连上 count 台设备、收完各自的补齐 */
export async function connectAll(name: string, cookie: Cookie, count: number) {
  const devices: Awaited<ReturnType<typeof connect>>[] = [];
  for (let index = 0; index < count; index += 1) {
    const device = await connect(name, cookie);
    await device.next();
    devices.push(device);
  }
  return devices;
}

/** 新空间：HTTP 整份拉过一次，再连上 count 台设备、收完各自的补齐 */
export async function online(count: number) {
  const name = space();
  const { cookie } = await pull(name, null);
  const devices = await connectAll(name, cookie, count);
  const [phone = devices[0], tablet = devices[0]] = devices;
  if (!phone || !tablet) throw new Error('至少要一台设备');
  return { name, cookie, phone, tablet };
}

export const put = (table: string, row: Record<string, string>): Change => ({ op: 'put', table, row });

/** 设备 c1 的第 1 条写：加一条笔记 n1 */
export const squat = { id: 1, changes: [put('note', { id: 'n1', text: '深蹲' })] };

/** 替身的去处（对象或入口）：记下转来的每个请求，都回空的 JSON */
export function recording() {
  const seen: Request[] = [];
  return {
    seen,
    target: {
      fetch: async (request: Request) => {
        seen.push(request);
        return new Response('{}');
      },
    },
  };
}
