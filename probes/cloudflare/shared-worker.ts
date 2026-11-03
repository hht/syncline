import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { SynclineBroadcast, SynclineSharedSpace } from '../../src/cloudflare/index.ts';

// 量平台限制用的临时 Worker（shared-write.ts 部署、量完删掉）：一张表 item 的共用空间，按 owner 分桶，广播分片取默认的个数。
// 请求带部署时随机定的 SECRET，部署着的这几分钟里别人调不动

type Env = { SHARED: DurableObjectNamespace<ProbeShared>; BROADCAST: DurableObjectNamespace<ProbeBroadcast>; SECRET: string };

const item = sqliteTable('item', { id: text().primaryKey(), owner: text().notNull() });

/** 一次后台写：spread 插入 rows 行、各在一个新桶；move 把 spread 的行各挪到一个新桶（离开一个、进一个）；same 插入 rows 行、都在同一个桶 */
type Kind = 'spread' | 'move' | 'same';

export class ProbeShared extends SynclineSharedSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { schema: { item }, buckets: { owner: { item: { by: ['owner'] } } }, broadcast: (bindings) => bindings.BROADCAST });
  }

  /** 各表的桶行数都数完了：没数完时写进来的行不增减行数，量出的就少了这一块 */
  counted() {
    return (
      this.ctx.storage.sql.exec<{ left: number }>('SELECT count(*) AS left FROM _syncline_counted WHERE after IS NOT NULL').one().left === 0
    );
  }

  write(kind: Kind, rows: number) {
    return this.mutate((tx) => {
      for (let index = 0; index < rows; index += 1) {
        const id = `${kind === 'same' ? 'same' : 'spread'}-${index}`;
        const owner = kind === 'same' ? 'one' : crypto.randomUUID();
        if (kind === 'move') tx.update(item, { id, owner });
        else tx.insert(item, { id, owner });
      }
    });
  }
}

export class ProbeBroadcast extends SynclineBroadcast<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, env.SHARED);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const space = url.searchParams.get('space');
    // 没设 SECRET（不经 shared-write.ts 部署）时一律拒绝
    if (!space || !env.SECRET || url.searchParams.get('secret') !== env.SECRET) return new Response(null, { status: 403 });
    const shared = env.SHARED.getByName(space);
    if (url.pathname === '/counted') return Response.json(await shared.counted());
    await shared.write(url.searchParams.get('kind') as Kind, Number(url.searchParams.get('rows')));
    return Response.json(true);
  },
} satisfies ExportedHandler<Env>;
