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
 * 入口 Worker 怎么接共用空间的请求：认协议版本与身份，照桶规则查令牌给的订阅、编成规范写法；WebSocket 随机转给一个广播分片，
 * HTTP 拉取按协议的参数重建网址、经开了缓存的入口（SynclineSharedEntry）拉，回给设备的不让存；入口把订阅放在请求头上，共用空间与分片照 subscribedOf 取。
 * 不该知道的：身份怎么验、订阅怎么从身份定（接入方给 verify）、共用空间与分片里怎么处理请求。
 */

/** 入口验过的身份：设备订阅的桶与到期的时刻（毫秒） */
export type SharedIdentity = { buckets: Bucket[]; expiresAt: number };

/** 订阅（规范写法的 JSON）与它的指纹放在转给共用空间与广播分片的请求头上：它们没有公网地址，只有入口转得进来 */
export const subscriptionHeader = 'Syncline-Subscription';
export const subHeader = 'Syncline-Sub';

/** 分片的名字：共用空间的名字 + # + 序号，分片据此找回自己的共用空间 */
export const shardName = (space: string, index: number) => `${space}#${index}`;

/**
 * 一个共用空间的定义：入口（forwardShared）与共用空间（SynclineSharedSpace）用同一份，两边的表、桶规则与分片数才一致——
 * 入口照规则查订阅、按订阅分缓存、按分片数随机转 WebSocket，共用空间照规则算块、按分片数发通知
 */
export type SharedDefinition = {
  /** 同步的表（表名 → Drizzle 表） */
  schema: Schema;
  /** 桶规则：规则名 → 表名 → 这张表的哪些行进这条规则的桶 */
  buckets: BucketRules;
  /** 广播分片几片，默认 128 */
  shards?: number;
  /** 每满几行改到的行一个块边界 */
  chunkRows?: number;
};

/** 入口转给开了缓存的入口的：共用空间的名字与设备的订阅（缓存键里有它） */
export type EntryProps = { space: string } & Subscribed;

/** 入口 Worker 交给 forwardShared 的：开了缓存的入口（ctx.exports 上的那个类）、广播分片、共用空间的名字与定义 */
type Route<Broadcast extends Rpc.DurableObjectBranded> = {
  entry: (options: { props: EntryProps }) => { fetch(request: Request): Promise<Response> };
  broadcast: DurableObjectNamespace<Broadcast>;
  space: string;
  definition: SharedDefinition;
};

/** 每份定义的桶规则只校验一次（入口 Worker 的一个实例处理很多请求） */
const parsed = new WeakMap<SharedDefinition, Buckets>();

function bucketsOf(definition: SharedDefinition) {
  const known = parsed.get(definition);
  if (known) return known;
  const buckets = new Buckets(Object.values(definition.schema), definition.buckets);
  parsed.set(definition, buckets);
  return buckets;
}

/**
 * 入口 Worker 里共用空间的入口：admit 认出的身份照桶规则编成订阅（不合规则、超了上限就抛错：接入方的 verify 写错了，或要换一种分桶），
 * WebSocket 随机转给一个广播分片，HTTP 拉取去掉 Authorization（带它的请求不进缓存）、经开了缓存的入口拉。
 * 入口要写成 ctx.exports.X({ props }).fetch：写成 ctx.exports.X.fetch(request, { props }) 时 props 传不进去，所有订阅共用一份缓存
 */
export async function forwardShared<Broadcast extends Rpc.DurableObjectBranded>(
  request: Request,
  route: Route<Broadcast>,
  verify: (token: string) => Promise<SharedIdentity | undefined>,
) {
  const identity = await admit(request, verify);
  if (identity instanceof Response) return identity;
  const subscription = bucketsOf(route.definition).subscribe(identity.buckets);
  const subscribed = { subscription, sub: await subscriptionHash(subscription) };
  if (request.headers.get('Upgrade') === 'websocket') {
    const forwarded = withoutToken(request);
    forwarded.headers.set(expiresHeader, String(identity.expiresAt));
    forwarded.headers.set(subscriptionHeader, JSON.stringify(subscription));
    forwarded.headers.set(subHeader, subscribed.sub);
    const shard = Math.floor(Math.random() * (route.definition.shards ?? defaultShards));
    return route.broadcast.getByName(shardName(route.space, shard)).fetch(forwarded);
  }
  // HTTP 拉取（只有 GET）：缓存键只由协议的参数决定，按固定次序重建网址、cursor 照规范写法重写，不带请求头（带 Authorization 的不进缓存，
  // X-Forwarded-Host 这类头也进缓存键），换参数次序、cursor 的写法、加参数、加头都打不到共用空间上；解析不了的 admit 已回了 400
  // @see https://developers.cloudflare.com/workers/cache/cache-keys/
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  const target = new URL(request.url);
  let pull = parsePullRequest(target);
  // 认不出的 cursor（伪造的、换格式之前发出的）原样转去，共用空间回 reset、设备从头重下，不回 400：设备拿着它会一直重试
  if (pull.cursor !== undefined) pull = { ...pull, cursor: canonicalPosition(pull.cursor) ?? pull.cursor };
  const canonical = new Request(pullURL(`${target.origin}${target.pathname}`, pull));
  const cached = await route.entry({ props: { space: route.space, ...subscribed } }).fetch(canonical);
  // 只在入口后面按订阅缓存：设备（iOS、Android 的 HTTP 栈与浏览器）与途中的缓存只按网址分，同一台设备换了订阅（管理员退出、普通用户登录）
  // 拉同一个网址会拿到上一份订阅的块，所以回给设备的一律不让存
  // @see https://www.rfc-editor.org/rfc/rfc9111#section-5.2.2.5
  const response = new Response(cached.body, cached);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** 带缓存的入口：缓存键是这个入口、路径与查询串、ctx.props（共用空间的名字与设备的订阅） */
export abstract class SynclineSharedEntry<Env = unknown> extends WorkerEntrypoint<Env, EntryProps> {
  /** 共用空间的命名空间 */
  protected abstract shared(): DurableObjectNamespace;

  override fetch(request: Request) {
    const forwarded = new Request(request);
    forwarded.headers.set(subscriptionHeader, JSON.stringify(this.ctx.props.subscription));
    forwarded.headers.set(subHeader, this.ctx.props.sub);
    return this.shared().getByName(this.ctx.props.space).fetch(forwarded);
  }
}

/** 入口放在请求头上的订阅（入口编好的规范写法与指纹）；没有是请求没经入口转来 */
export function subscribedOf(request: Request): Subscribed | undefined {
  const subscription = request.headers.get(subscriptionHeader);
  const sub = request.headers.get(subHeader);
  return subscription === null || sub === null ? undefined : { subscription: JSON.parse(subscription) as string[], sub };
}
