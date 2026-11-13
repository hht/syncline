import type { Server } from '../../src/cloud/server.ts';
import { bearer, bearerToken, subprotocol } from '../../src/protocol/messages.ts';
import { parsePullBody, parsePullRequest } from '../../src/protocol/pull-url.ts';
import { versionConflict, versionParam } from '../../src/protocol/version.ts';
import { schemaConflict, schemaPrefix } from '../../src/tables/declaration.ts';
import type { Answer } from './test-requests.ts';
import type { CloudEnd } from './test-sockets.ts';

// Entry Worker in deterministic simulation: validates protocol version (returns cloud version on mismatch),
// authenticates token and schema fingerprint; invalid requests fail WebSocket handshake or return 401 on HTTP pull;
// valid requests forward to cloud actor.

/** Cloud target forwarded by mock Worker: private space uses Server; shared space uses broadcast shards and DO. */
export type Cloud = {
  accept(socket: CloudEnd, url: URL, expiresAt: number, fingerprint?: string): void | Promise<void>;
  receive(socket: CloudEnd, message: string): void;
  /** HTTP pull: shared space request in query URL, private space request in POST body. */
  pull(url: URL, body: string | undefined): string;
  /** Private space compares client schema fingerprint: on mismatch returns schemaConflict with cloud schema. */
  schemaConflict?(fingerprint: string): string | undefined;
};

/** Adapts private space Server as mock Worker cloud backend; parses pull body. */
export const privateCloud = (server: Server<CloudEnd>, space?: string): Cloud => ({
  accept: (socket, url, expiresAt, fingerprint) => server.accept(socket, parsePullRequest(url).cookie, expiresAt, fingerprint, space),
  receive: (socket, message) => server.receive(socket, message),
  pull: (_url, body) => server.pull(parsePullBody(body ?? ''), space),
  schemaConflict: (fingerprint) => server.schemaConflict(fingerprint),
});

/**
 * Mock Worker recognized tokens and expiry timestamps: renewed is acquired prior to expiry;
 * expiring will expire (schedules renewal based on cloud expiry hint); lapsing connects but expires on first message.
 */
const identities = new Map([
  ['valid', Number.POSITIVE_INFINITY],
  ['std/b64+x=, y', Number.POSITIVE_INFINITY],
  ['renewed', Number.POSITIVE_INFINITY],
  ['expiring', Number.MAX_SAFE_INTEGER],
  ['lapsing', 0],
]);

/** Integrator token() generator: mostly valid tokens (some expiring), occasionally immediate expiry, invalid, or undefined. */
export const tokens = [...Array<string>(4).fill('valid'), ...Array<string>(3).fill('expiring'), 'lapsing', 'revoked', undefined];

/** Whether client protocol version mismatches mock Worker version. */
export const mismatched = (url: string, cloudVersion: number) => new URL(url).searchParams.get(versionParam) !== String(cloudVersion);

/** Parses WebSocket subprotocols for token expiry and schema fingerprint. */
export function admitSocket(protocols: string[]) {
  const token = protocols.includes(subprotocol) ? protocols.find((protocol) => protocol.startsWith(bearer)) : undefined;
  const expiresAt = identities.get(bearerToken(token?.slice(bearer.length) ?? '') ?? '');
  const schema = protocols.find((protocol) => protocol.startsWith(schemaPrefix))?.slice(schemaPrefix.length);
  return { expiresAt, ...(schema === undefined ? {} : { schema }) };
}

/** Evaluates HTTP response at mock Worker: validates version, schema, and auth before forwarding to pull; returns 500 on fault. */
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
