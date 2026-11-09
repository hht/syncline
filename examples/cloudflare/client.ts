import { exports } from 'cloudflare:workers';
import { signToken } from './auth.ts';
import type { User } from './definition.ts';

// Test client speaking the wire format devices use (protocol version 5). The format is internal to Syncline and changes with its
// protocol version; the app itself never needs this.

type Op = { op: string; table?: string; key?: Record<string, unknown>; row?: Record<string, unknown> };
type Final = { cookie: { version: number; nonce: number }; patch: Op[] };
type Chunk = { next: string; patch: Op[] } | Final;

const origin = 'https://example.test';
const version = 'v=5';

/** A token for a user expiring in one hour. */
export const tokenFor = (user: Omit<User, 'expiresAt'>) =>
  signToken({ ...user, expiresAt: Date.now() + 3_600_000 }, 'local-development-only');

/** Downloads a shared space from scratch through the entry Worker; returns the rows by table and the cookie to connect with. */
export async function pull(token: string, path = '/shared') {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (let cursor = ''; ; ) {
    const response = await exports.default.fetch(`${origin}${path}?${version}${cursor && `&cursor=${encodeURIComponent(cursor)}`}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Pull failed with ${response.status}`);
    const chunk = (await response.json()) as Chunk;
    for (const op of chunk.patch) if (op.op === 'put' && op.table && op.row) rows[op.table] = [...(rows[op.table] ?? []), op.row];
    if ('cookie' in chunk) return { rows, cookie: chunk.cookie };
    cursor = chunk.next;
  }
}

/** Opens a live connection from cookie; `next` resolves with the rows put by each following message. */
export async function connect(token: string, cookie: Final['cookie']) {
  const response = await exports.default.fetch(`${origin}/shared?${version}&cookie=${cookie.version}.${cookie.nonce}`, {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `syncline, bearer.${encodeURIComponent(token)}` },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error(`Connection failed with ${response.status}`);
  const messages: Op[][] = [];
  const waiting: ((ops: Op[]) => void)[] = [];
  socket.addEventListener('message', ({ data }) => {
    const ops = ((JSON.parse(String(data)) as { patch?: Op[] }).patch ?? []).filter((op) => op.op === 'put');
    const resolve = waiting.shift();
    if (resolve) resolve(ops);
    else messages.push(ops);
  });
  socket.accept();
  return {
    next: () => new Promise<Op[]>((resolve) => (messages.length > 0 ? resolve(messages.shift() as Op[]) : waiting.push(resolve))),
    close: () => socket.close(),
  };
}
