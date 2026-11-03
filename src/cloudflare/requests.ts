import { bearer } from '../common/protocol.ts';
import { schemaHeader, schemaPrefix } from '../tables/declaration.ts';

/**
 * 设备的请求里带着什么：token 与表结构的指纹。WebSocket 都在子协议里（浏览器的 WebSocket 设不了请求头），HTTP 拉取在请求头里。
 * 不该知道的：token 怎么验、表结构怎么比。
 */

/** WebSocket 的子协议里以 prefix 开头的那一个，去掉 prefix */
const protocolOf = (request: Request, prefix: string) =>
  request.headers
    .get('Sec-WebSocket-Protocol')
    ?.split(',')
    .map((protocol) => protocol.trim())
    .find((protocol) => protocol.startsWith(prefix))
    ?.slice(prefix.length);

export const isSocket = (request: Request) => request.headers.get('Upgrade') === 'websocket';

/**
 * 转给对象之前去掉 token（对象用不着，免得进对象的日志与报错）：HTTP 拉取去掉 Authorization，WebSocket 去掉子协议里的 token
 * （握手照样回 syncline）
 */
export function withoutToken(request: Request) {
  const forwarded = new Request(request);
  forwarded.headers.delete('Authorization');
  const protocols = request.headers.get('Sec-WebSocket-Protocol');
  if (protocols !== null)
    forwarded.headers.set(
      'Sec-WebSocket-Protocol',
      protocols
        .split(',')
        .map((protocol) => protocol.trim())
        .filter((protocol) => !protocol.startsWith(bearer))
        .join(', '),
    );
  return forwarded;
}

/** 设备带的 token：WebSocket 在子协议里，HTTP 拉取在 Authorization 头里 */
export function tokenOf(request: Request) {
  if (isSocket(request)) return protocolOf(request, bearer);
  return /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
}

/** 设备带的表结构的指纹（schemaPrefix、schemaHeader）：不带是 undefined */
export const schemaFingerprintOf = (request: Request) =>
  isSocket(request) ? protocolOf(request, schemaPrefix) : (request.headers.get(schemaHeader) ?? undefined);
