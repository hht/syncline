import { bearer } from '../common/protocol.ts';
import { schemaHeader, schemaPrefix } from '../tables/declaration.ts';

/**
 * Extracts tokens and schema fingerprints from client requests:
 * WebSocket connections pass them via subprotocols (browsers cannot set WebSocket headers); HTTP pulls pass them via headers.
 */

/** Returns the subprotocol value stripped of prefix, or undefined if absent. */
const protocolOf = (request: Request, prefix: string) =>
  request.headers
    .get('Sec-WebSocket-Protocol')
    ?.split(',')
    .map((protocol) => protocol.trim())
    .find((protocol) => protocol.startsWith(prefix))
    ?.slice(prefix.length);

export const isSocket = (request: Request) => request.headers.get('Upgrade') === 'websocket';

/**
 * Strips the token before forwarding to Durable Objects to avoid leaking it into logs or error traces:
 * removes the Authorization header on HTTP pulls, and removes the token subprotocol on WebSockets.
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

/** Extracts the client token from the WebSocket subprotocol or HTTP Authorization header. */
export function tokenOf(request: Request) {
  if (isSocket(request)) return protocolOf(request, bearer);
  return /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
}

/** Extracts the schema fingerprint from WebSocket subprotocols or HTTP headers, or undefined if omitted. */
export const schemaFingerprintOf = (request: Request) =>
  isSocket(request) ? protocolOf(request, schemaPrefix) : (request.headers.get(schemaHeader) ?? undefined);
