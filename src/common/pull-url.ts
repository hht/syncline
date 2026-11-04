import { bounds, invalid, isCount, isNames, isObject, parseCookie, cookie as parseCookieValue } from './parse.ts';
import { type Cookie, formatCookie, type PullRange } from './protocol.ts';
import { protocolVersion, versionParam } from './version.ts';

/**
 * Request formatting for HTTP pulls and WebSocket connections.
 * Shared space pulls use HTTP GET with all request parameters encoded into query strings for edge caching.
 * Private space pulls bypass the CDN cache using HTTP POST with JSON request bodies to avoid 16 KB URL limits from client ID lists.
 * WebSocket connection URLs carry protocol version and cookie query parameters.
 * @see https://doc.replicache.dev/reference/server-pull
 * @see https://developers.cloudflare.com/workers/platform/limits/
 */

/**
 * Pull request parameters.
 * Cookie specifies the local cookie (null before initial sync), and cursor carries pagination resume tokens.
 * Shared spaces carry landed subscriptions, atLeast version floors, and incarnation tokens.
 * Private spaces carry refetch flags, checksum parameters, range pulls, and client sequence boundaries.
 */
export type PullRequest = {
  cookie: Cookie | null;
  cursor?: string;
  landed?: string;
  atLeast?: number;
  incarnation?: number;
  refetch?: true;
  checksum?: string;
  checksumRows?: number;
  ranges?: PullRange[];
  clients?: string[];
  earliest?: Record<string, number>;
};

// Query parameters for shared space HTTP pulls and WebSocket connection URLs.
type QueryRequest = Pick<PullRequest, 'cookie' | 'cursor' | 'landed' | 'atLeast' | 'incarnation'>;

// Cookie query parameter formatted as `cookie=version.nonce`.
const cookieParam = 'cookie';
// Query parameter names for cursors, landed subscriptions, version floors, and incarnations.
const cursorParam = 'cursor';
const landedParam = 'landed';
const atLeastParam = 'atLeast';
const incarnationParam = 'incarnation';

/** Builds a pull or WebSocket connection URL with protocol version and request query parameters. */
export function pullURL(url: string, { cookie, cursor, landed, atLeast, incarnation }: QueryRequest = { cookie: null }) {
  const target = new URL(url);
  target.searchParams.set(versionParam, String(protocolVersion));
  if (cookie) target.searchParams.set(cookieParam, formatCookie(cookie));
  if (cursor !== undefined) target.searchParams.set(cursorParam, cursor);
  if (landed !== undefined) target.searchParams.set(landedParam, landed);
  if (atLeast !== undefined) target.searchParams.set(atLeastParam, String(atLeast));
  if (incarnation !== undefined) target.searchParams.set(incarnationParam, String(incarnation));
  return target.href;
}

// Parses a non-negative integer query parameter or returns undefined when absent.
function countOf(url: URL, name: string, what: string) {
  const text = url.searchParams.get(name);
  if (text !== null && !/^\d+$/.test(text)) invalid(what, text);
  return text === null ? undefined : Number(text);
}

/** Parses shared space pull query parameters, rejecting unrecognized parameters to protect CDN cache keys. */
export function parsePullRequest(url: URL): QueryRequest {
  const unknown = [...url.searchParams.keys()].find(
    (key) => ![versionParam, cookieParam, cursorParam, landedParam, atLeastParam, incarnationParam].includes(key),
  );
  if (unknown !== undefined) invalid('Pull param', unknown);
  const cursor = url.searchParams.get(cursorParam);
  const landed = url.searchParams.get(landedParam);
  const atLeast = countOf(url, atLeastParam, 'Pull floor');
  const incarnation = countOf(url, incarnationParam, 'Pull incarnation');
  return {
    cookie: parseCookie(url.searchParams.get(cookieParam)),
    ...(cursor === null ? {} : { cursor }),
    ...(landed === null ? {} : { landed }),
    ...(atLeast === undefined ? {} : { atLeast }),
    ...(incarnation === undefined ? {} : { incarnation }),
  };
}

// Parses table ranges requested for rescan, allowing at most one entry per table.
function rangesOf(value: unknown): PullRange[] {
  if (!Array.isArray(value)) invalid('Pull ranges', value);
  const tables = new Set<string>();
  return value.map((item: unknown) => {
    if (!isObject(item) || typeof item.table !== 'string' || item.table === '' || tables.has(item.table)) invalid('Pull ranges', item);
    tables.add(item.table);
    return { table: item.table, ...bounds(item) };
  });
}

// Validates permitted request body field types.
const bodyChecks: Record<string, (value: unknown) => boolean> = {
  cursor: (value) => typeof value === 'string',
  refetch: (value) => value === true,
  checksum: (value) => typeof value === 'string',
  checksumRows: (value) => isCount(value) && value > 0,
  clients: isNames,
  // Earliest pending mutation ID per client (1-based sequence numbers).
  earliest: (value) => isObject(value) && Object.values(value).every((id) => isCount(id) && id > 0),
};

/** Parses a private space HTTP pull request body, rejecting unrecognized or malformed properties. */
export function parsePullBody(text: string): PullRequest {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) invalid('Pull body', value);
  const { cookie, ranges, ...rest } = value;
  // Checks own properties against bodyChecks to exclude Object.prototype methods.
  for (const [key, item] of Object.entries(rest))
    if (!Object.hasOwn(bodyChecks, key) || !bodyChecks[key]?.(item)) invalid(`Pull ${key}`, item);
  return {
    ...(rest as Omit<PullRequest, 'cookie' | 'ranges'>),
    cookie: cookie === null ? null : parseCookieValue(cookie),
    ...(ranges === undefined ? {} : { ranges: rangesOf(ranges) }),
  };
}
