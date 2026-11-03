import { subprotocol } from '../common/protocol.ts';
import { parsePullRequest } from '../common/pull-url.ts';
import { protocolVersion, versionConflict, versionMismatch, versionParam } from '../common/version.ts';
import { isSocket, tokenOf, withoutToken } from './requests.ts';

/**
 * 入口 Worker 怎么接同步请求：认协议版本与身份，带着身份转给要连的空间。
 * 不该知道的：身份怎么验（接入方给 verify）、对象里怎么处理请求。
 */

/** 入口 Worker 验过的身份：要连的空间、到期的时刻（毫秒） */
export type Identity = { space: string; expiresAt: number };

// forward 把身份到期的时刻与要连的空间放在转给 Durable Object 的请求头上：对象没有公网地址，只有入口 Worker 转得进来，设备自己带的同名头被覆盖。
// 不经 RPC 传：RPC 的返回值不能带 WebSocket（DataCloneError）
export const expiresHeader = 'Syncline-Expires';
export const spaceHeader = 'Syncline-Space';

/**
 * 转进对象的请求上入口放的一个数（到期的时刻）：头在、是有限的数才给出，否则是 undefined，调用方当作不是经入口转来的。
 * 缺的头读出 null、空串，Number 都给 0，不能当成 0
 */
export function numberHeader(request: Request, name: string) {
  const text = request.headers.get(name);
  const value = text === null || text.trim() === '' ? Number.NaN : Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** 协议版本对不上时回云端的版本：HTTP 拉取回 409；WebSocket 由入口自己接受、随即以 versionMismatch 关闭（浏览器的 WebSocket 看不到握手失败的应答） */
function versionRejected(request: Request) {
  if (!isSocket(request)) return new Response(String(protocolVersion), { status: versionConflict });
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(versionMismatch, String(protocolVersion));
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': subprotocol } });
}

/**
 * 两个入口共用的一步：先认协议版本，对不上回云端的版本、不转给对象；再取出设备带的 token 交给 verify，
 * 没带或认不出回 401；最后认查询串（parsePullRequest，WebSocket 的连接网址与共用空间的 HTTP 拉取是同一种；私有空间的 POST 只带版本），
 * 认不出的是伪造的或设备的缺陷，回 400、不唤醒对象，对象里照样认、不再出错。私有空间 POST 的正文不在这里读，对象里认（认不出回 400）。
 * WebSocket 握手失败时设备只看到 1006，照常按退避重连（重连时取新 token）。认出了返回身份，否则返回该回给设备的应答
 */
export async function admit<T>(request: Request, verify: (token: string) => Promise<T | undefined>): Promise<T | Response> {
  const url = new URL(request.url);
  if (url.searchParams.get(versionParam) !== String(protocolVersion)) return versionRejected(request);
  const token = tokenOf(request);
  const identity = token ? await verify(token) : undefined;
  // 接入方用纯 JS 写的 verify 可能给 null：一样当认不出
  if (identity === undefined || identity === null) return new Response(null, { status: 401 });
  try {
    parsePullRequest(url);
  } catch {
    return new Response(null, { status: 400 });
  }
  return identity;
}

/** 入口 Worker 里同步请求的入口：admit 认出的身份转给它的空间 */
export async function forward<Space extends Rpc.DurableObjectBranded>(
  request: Request,
  namespace: DurableObjectNamespace<Space>,
  verify: (token: string) => Promise<Identity | undefined>,
) {
  const identity = await admit(request, verify);
  if (identity instanceof Response) return identity;
  const forwarded = withoutToken(request);
  forwarded.headers.set(expiresHeader, String(identity.expiresAt));
  forwarded.headers.set(spaceHeader, identity.space);
  return namespace.getByName(identity.space).fetch(forwarded);
}
