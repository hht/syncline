import type { Server } from '../cloud/server.ts';
import { bearer, subprotocol } from '../common/protocol.ts';
import { parsePullBody, parsePullRequest } from '../common/pull-url.ts';
import { versionConflict, versionParam } from '../common/version.ts';
import { schemaConflict, schemaPrefix } from '../tables/declaration.ts';
import type { Answer } from './test-requests.ts';
import type { CloudEnd } from './test-sockets.ts';

// 确定性模拟里的入口 Worker：先认协议版本（对不上的回云端的版本），再认 token 与表结构的指纹，
// 认不出的 WebSocket 握手失败、HTTP 拉取回 401；认出了交给云端

/** 替身 Worker 转给的云端：私有空间是 Server；共用空间是广播分片（接受连接）与共用空间的 DO（HTTP 拉取） */
export type Cloud = {
  accept(socket: CloudEnd, url: URL, expiresAt: number, fingerprint?: string): void | Promise<void>;
  receive(socket: CloudEnd, message: string): void;
  /** HTTP 拉取：共用空间的请求在网址里，私有空间的在 POST 的正文 body 里 */
  pull(url: URL, body: string | undefined): string;
  /** 私有空间比设备带的表结构的指纹：对不上时 HTTP 拉取回 schemaConflict、正文是云端的表结构；共用空间不比、不给 */
  schemaConflict?(fingerprint: string): string | undefined;
};

/** 私有空间的 Server 当作替身 Worker 转给的云端：拉取的正文照对象解析；space 是入口验过的身份 */
export const privateCloud = (server: Server<CloudEnd>, space?: string): Cloud => ({
  accept: (socket, url, expiresAt, fingerprint) => server.accept(socket, parsePullRequest(url).cookie, expiresAt, fingerprint, space),
  receive: (socket, message) => server.receive(socket, message),
  pull: (_url, body) => server.pull(parsePullBody(body ?? ''), space),
  schemaConflict: (fingerprint) => server.schemaConflict(fingerprint),
});

/**
 * 替身 Worker 认的 token 与身份到期的时刻：renewed 是到期前换来的新 token；expiring 会到期（时刻很远，设备照云端给的剩余时长排续约，
 * 计时器由种子挑着触发）；lapsing 连得上，但第一次收发就已过期
 */
const identities = new Map([
  ['valid', Number.POSITIVE_INFINITY],
  ['renewed', Number.POSITIVE_INFINITY],
  ['expiring', Number.MAX_SAFE_INTEGER],
  ['lapsing', 0],
]);

/** 接入方的 token()：大多给出有效的（有的会到期、要续约），有时给出马上过期的、认不出的，或者取不到 */
export const tokens = [...Array<string>(4).fill('valid'), ...Array<string>(3).fill('expiring'), 'lapsing', 'revoked', undefined];

/** 设备带的协议版本对不上替身 Worker 的 */
export const mismatched = (url: string, cloudVersion: number) => new URL(url).searchParams.get(versionParam) !== String(cloudVersion);

/** WebSocket 的子协议里设备带的：身份到期的时刻（认不出 token 是 undefined；浏览器：云端回的子协议不在设备发的里面，连接失败）与表结构的指纹 */
export function admitSocket(protocols: string[]) {
  const token = protocols.includes(subprotocol) ? protocols.find((protocol) => protocol.startsWith(bearer)) : undefined;
  const expiresAt = identities.get(token?.slice(bearer.length) ?? '');
  const schema = protocols.find((protocol) => protocol.startsWith(schemaPrefix))?.slice(schemaPrefix.length);
  return { expiresAt, ...(schema === undefined ? {} : { schema }) };
}

/** 替身 Worker 与对象算一个请求的应答：先认协议版本、表结构的指纹与身份，再交给对象（pull）；对象出了注入的故障（pull 给 undefined）回 500 */
export function answer(
  request: Parameters<Answer>[0],
  cloudVersion: number,
  cloud: Cloud,
  pull: () => string | undefined,
): ReturnType<Answer> {
  if (mismatched(request.url, cloudVersion)) return { status: versionConflict, body: String(cloudVersion) };
  const schema = identities.has(request.token) && request.schema !== undefined && cloud.schemaConflict?.(request.schema);
  if (schema) return { status: schemaConflict, body: schema };
  if (!identities.has(request.token)) return { status: 401, body: null };
  const pulled = pull();
  return pulled === undefined ? { status: 500, body: null } : { status: 200, body: pulled };
}
