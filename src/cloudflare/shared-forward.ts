import { WorkerEntrypoint } from 'cloudflare:workers';
import { defaultShards } from '../cloud/broadcast.ts';
import { type Bucket, type BucketRules, Buckets, subscriptionHash } from '../cloud/buckets.ts';
import { canonicalPosition } from '../cloud/position.ts';
import type { Subscribed } from '../cloud/shared.ts';
import { parsePullRequest, pullURL } from '../common/pull-url.ts';
import type { Schema } from '../tables/table-definitions.ts';
import { admit, expiresHeader } from './forward.ts';
import { withoutToken } from './requests.ts';

/**
 * Handles shared space requests in entry Workers:
 * validates protocol version and identity, normalizes bucket subscriptions from rules, routes WebSockets randomly to broadcast shards,
 * and reconstructs canonical URLs for HTTP pulls routed through cached {@link SynclineSharedEntry}.
 */

/** Authenticated identity verified for a shared space: subscribed buckets and expiry epoch milliseconds. */
export type SharedIdentity = { buckets: Bucket[]; expiresAt: number };

// Headers carrying the canonical subscription JSON and SHA-256 digest forwarded to Durable Objects.
export const subscriptionHeader = 'Syncline-Subscription';
export const subHeader = 'Syncline-Sub';

/** Returns the deterministic broadcast shard name: spaceName#shardIndex. */
export const shardName = (space: string, index: number) => `${space}#${index}`;

/** Returns a definition's broadcast shard count: the entry routes devices among these shards and the space fans out to all of them. */
export const shardCount = ({ shards = defaultShards }: Pick<SharedDefinition, 'shards'>) => shards;

/** Configuration for a shared space shared across entry Workers and {@link SynclineSharedSpace}. */
export type SharedDefinition = {
  /** Synced tables (table name -> Drizzle table). */
  schema: Schema;
  /** Bucket rules mapping rule names to covered tables and conditions. */
  buckets: BucketRules;
  /** Broadcast shard count, default 128. */
  shards?: number;
  /** Chunk boundary row threshold. */
  chunkRows?: number;
};

/** Props passed to cached entrypoints: space name and normalized subscription. */
export type EntryProps = { space: string } & Subscribed;

// Routing options passed to forwardShared: cached entrypoint, broadcast namespace, space name, and definition.
type Route<Broadcast extends Rpc.DurableObjectBranded> = {
  entry: (options: { props: EntryProps }) => { fetch(request: Request): Promise<Response> };
  broadcast: DurableObjectNamespace<Broadcast>;
  space: string;
  definition: SharedDefinition;
};

// Caches parsed bucket rules per SharedDefinition instance.
const parsed = new WeakMap<SharedDefinition, Buckets>();

function bucketsOf(definition: SharedDefinition) {
  const known = parsed.get(definition);
  if (known) return known;
  const buckets = new Buckets(Object.values(definition.schema), definition.buckets);
  parsed.set(definition, buckets);
  return buckets;
}

/**
 * Entry Worker router for shared spaces: compiles the authenticated identity into a subscription against the bucket rules
 * (throwing if invalid or over the byte limit, indicating a bug in `verify` or a need to re-partition buckets),
 * routes WebSockets to a random broadcast shard, and strips `Authorization` (which bypasses cache) on HTTP pulls before calling the cached entrypoint.
 * Pass `entry` as `ctx.exports.X` itself, which this calls with the subscription as `props`: `ctx.exports.X.fetch(request, { props })` does not forward `props`.
 */
export function forwardShared<Broadcast extends Rpc.DurableObjectBranded>(
  request: Request,
  route: Route<Broadcast>,
  verify: (token: string) => Promise<SharedIdentity | undefined>,
) {
  return admit(request, verify, (identity) => routed(request, route, identity));
}

async function routed<Broadcast extends Rpc.DurableObjectBranded>(request: Request, route: Route<Broadcast>, identity: SharedIdentity) {
  const subscription = bucketsOf(route.definition).subscribe(identity.buckets);
  const subscribed = { subscription, sub: await subscriptionHash(subscription) };
  if (request.headers.get('Upgrade') === 'websocket') {
    const forwarded = withoutToken(request);
    forwarded.headers.set(expiresHeader, String(identity.expiresAt));
    forwarded.headers.set(subscriptionHeader, JSON.stringify(subscription));
    forwarded.headers.set(subHeader, subscribed.sub);
    const shard = Math.floor(Math.random() * shardCount(route.definition));
    return route.broadcast.getByName(shardName(route.space, shard)).fetch(forwarded);
  }
  // HTTP pulls (GET only): rebuilds canonical URLs with sorted query parameters and canonical cursor to maximize cache hit rates.
  // @see https://developers.cloudflare.com/workers/cache/cache-keys/
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  const target = new URL(request.url);
  let pull = parsePullRequest(target);
  // Passes unrecognized cursors through so the shared space returns a reset to trigger a fresh full pull.
  if (pull.cursor !== undefined) pull = { ...pull, cursor: canonicalPosition(pull.cursor) ?? pull.cursor };
  const canonical = new Request(pullURL(`${target.origin}${target.pathname}`, pull));
  const cached = await route.entry({ props: { space: route.space, ...subscribed } }).fetch(canonical);
  // Cache by subscription behind the entry: downstream caches key by URL alone, so prevent intermediate caching with no-store.
  // @see https://www.rfc-editor.org/rfc/rfc9111#section-5.2.2.5
  const response = new Response(cached.body, cached);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** Cached entrypoint for shared space pulls keyed by URL path, query params, and subscription props. */
export abstract class SynclineSharedEntry<Env = unknown> extends WorkerEntrypoint<Env, EntryProps> {
  /** Returns the Durable Object namespace for the shared space. */
  protected abstract shared(): DurableObjectNamespace;

  override fetch(request: Request) {
    // ctx.exports.X.fetch(request, { props }) drops props: the pull would have no subscription, and its cache entry no key to split on.
    if (this.ctx.props.subscription === undefined)
      throw new Error(
        'SynclineSharedEntry received no props: reach it through forwardShared with entry ctx.exports.X, not ctx.exports.X.fetch',
      );
    const forwarded = new Request(request);
    forwarded.headers.set(subscriptionHeader, JSON.stringify(this.ctx.props.subscription));
    forwarded.headers.set(subHeader, this.ctx.props.sub);
    return this.shared().getByName(this.ctx.props.space).fetch(forwarded);
  }
}

/** Extracts canonical subscription and hash from forwarded request headers, or undefined if missing. */
export function subscribedOf(request: Request): Subscribed | undefined {
  const subscription = request.headers.get(subscriptionHeader);
  const sub = request.headers.get(subHeader);
  return subscription === null || sub === null ? undefined : { subscription: JSON.parse(subscription) as string[], sub };
}
