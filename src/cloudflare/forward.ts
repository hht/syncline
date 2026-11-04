import { subprotocol } from '../common/protocol.ts';
import { parsePullRequest } from '../common/pull-url.ts';
import { protocolVersion, versionConflict, versionMismatch, versionParam } from '../common/version.ts';
import { isSocket, tokenOf, withoutToken } from './requests.ts';

/**
 * Handles sync requests in entry Workers: validates protocol version and identity, forwarding valid requests to the destination space.
 */

/** Authenticated identity verified by an entry Worker: target space name and expiry epoch milliseconds. */
export type Identity = { space: string; expiresAt: number };

// Places expiry and space name in forwarded request headers: Durable Objects have no public IP and rely on entry Workers to set them.
// Avoids RPC since WebSocket instances cannot cross RPC boundaries (DataCloneError).
export const expiresHeader = 'Syncline-Expires';
export const spaceHeader = 'Syncline-Space';

/** Parses a numeric header (e.g. expiry epoch ms) forwarded by the entry Worker, returning undefined if missing or non-finite. */
export function numberHeader(request: Request, name: string) {
  const text = request.headers.get(name);
  const value = text === null || text.trim() === '' ? Number.NaN : Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** Rejects requests with mismatched protocol versions: returns 409 for HTTP pulls; accepts and closes WebSockets with versionMismatch. */
function versionRejected(request: Request) {
  if (!isSocket(request)) return new Response(String(protocolVersion), { status: versionConflict });
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(versionMismatch, String(protocolVersion));
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': subprotocol } });
}

/**
 * Shared admission pipeline for sync entry points:
 * validates protocol version (rejecting mismatches), authenticates tokens via verify (returning 401 on failure; throwing if
 * `expiresAt` is not a finite number, an integrator error), and parses pull URL query parameters (returning 400 on malformed
 * queries without waking the Durable Object).
 */
export async function admit<T extends { expiresAt: number }>(
  request: Request,
  verify: (token: string) => Promise<T | undefined>,
): Promise<T | Response> {
  const url = new URL(request.url);
  if (url.searchParams.get(versionParam) !== String(protocolVersion)) return versionRejected(request);
  const token = tokenOf(request);
  const identity = token ? await verify(token) : undefined;
  // Handle null returns from JavaScript verify callbacks as unauthenticated.
  if (identity === undefined || identity === null) return new Response(null, { status: 401 });
  if (!Number.isFinite(identity.expiresAt))
    throw new Error(`verify returned expiresAt ${identity.expiresAt}: expiresAt must be a finite number`);
  try {
    parsePullRequest(url);
  } catch {
    return new Response(null, { status: 400 });
  }
  return identity;
}

/** Forwards authenticated sync requests from the entry Worker to the corresponding private space Durable Object. */
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
