import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  forward,
  forwardShared,
  type SharedDefinition,
  SynclineBroadcast,
  SynclineSharedEntry,
  SynclineSharedSpace,
  SynclineSpace,
} from 'syncline/cloudflare';

// 平台测试用的 Worker：笔记与引用笔记的标签两张表的私有空间，请求经 forward 转进来；计划目录的共用空间（/catalog），经 forwardShared 转进来

export const note = sqliteTable('note', { id: text().primaryKey(), text: text().notNull() });
export const tag = sqliteTable('tag', {
  id: text().primaryKey(),
  note_id: text()
    .notNull()
    .references(() => note.id),
});

/** 接入方自己的定时到了：记进对象自己的存储（测试经 RPC 读 fired） */
const firedIn = (ctx: DurableObjectState) => ctx.storage.kv.get<string[]>('fired') ?? [];
const fire = (ctx: DurableObjectState, name: string) => ctx.storage.kv.put('fired', [...firedIn(ctx), name]);

export class TestSpace extends SynclineSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    // stats 在 exportFails 开着时出错，exportHangs 开着时一直不回话（D1、网络卡住）
    const misbehave = async () => {
      if (ctx.storage.kv.get('exportFails')) throw new Error('导出出错');
      if (ctx.storage.kv.get('exportHangs')) await new Promise(() => undefined);
    };
    // 导出者把收到的有改动的块与导到哪记进对象自己的存储（当作去处，测试经 RPC 读）：位置还是 from 才写，写完存下 next
    const destination = (key: string) => ({
      position: async () => ctx.storage.kv.get<string>(`${key}:position`),
      write: async ({ from, next, reset, patch }: { from: string | undefined; next: string; reset: boolean; patch: unknown[] }) => {
        if (key === 'exported') await misbehave();
        if (ctx.storage.kv.get<string>(`${key}:position`) !== from) return;
        if (reset || patch.length > 0) ctx.storage.kv.put(key, [...(ctx.storage.kv.get<unknown[]>(key) ?? []), { reset, patch }]);
        ctx.storage.kv.put(`${key}:position`, next);
      },
    });
    // 一次 alarm 的时间预算调短到 1 秒：测导出者一直不回话时不用等十分钟
    super(ctx, env, { note, tag }, { exports: { stats: destination('exported'), search: destination('searched') }, exportBudget: 1000 });
  }

  /** 导出者收到的各块（测试经 RPC 读） */
  exported() {
    return this.ctx.storage.kv.get<unknown[]>('exported') ?? [];
  }

  searched() {
    return this.ctx.storage.kv.get<unknown[]>('searched') ?? [];
  }

  /** 让 stats 导出者出错或恢复 */
  failExports(value: boolean) {
    this.ctx.storage.kv.put('exportFails', value);
  }

  /** 让 stats 导出者一直不回话或恢复 */
  hangExports(value: boolean) {
    this.ctx.storage.kv.put('exportHangs', value);
  }

  /** 接入方自己删掉了 alarm（比如它也用 alarm，又不管导出排着的那一次） */
  async clearAlarm() {
    await this.ctx.storage.deleteAlarm();
  }

  /** 排着的 alarm 的时刻（测试经 RPC 读）；没排是 null */
  alarmAt() {
    return this.ctx.storage.getAlarm();
  }

  /** 接入方自己的定时：登记、撤掉（测试经 RPC 调），到了记进 fired */
  remind(name: string, at: number) {
    this.schedule(name, at);
  }

  forget(name: string) {
    this.unschedule(name);
  }

  protected override scheduled = (name: string) => {
    fire(this.ctx, name);
    // 循环的定时：做的时候给自己排下一次
    if (name === 'recurring') this.schedule(name, Date.now() + 7 * 86_400_000);
  };

  fired() {
    return firedIn(this.ctx);
  }

  /** 扣下的写（测试经 RPC 读） */
  heldWrites() {
    return this.held();
  }

  /** 服务端写：补上没有的笔记；fail 时写完再抛，整条回滚、错误抛给调用方 */
  importNotes(notes: { id: string; text: string }[], fail = false) {
    this.mutate((tx) => {
      for (const row of notes) tx.insert(note, row);
      if (fail) throw new Error('导入出错');
    });
  }
}

const program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull() });

/** 计划目录的定义（入口与共用空间用同一份）：公开的桶只有已发布的，全部的桶都有；2 片广播，每 2 行一个块边界 */
const catalog = {
  schema: { program },
  buckets: { public: { program: { where: "status = 'published'" } }, all: { program: {} } },
  shards: 2,
  chunkRows: 2,
} satisfies SharedDefinition;

export class TestCatalog extends SynclineSharedSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { ...catalog, broadcast: (bindings) => bindings.CATALOG_BROADCAST });
  }

  /** 后台写：发布或改一个计划 */
  publish(id: string, status = 'published') {
    return this.mutate((tx) => tx.upsert(program, { id, status }));
  }

  /** 接入方自己的定时（测试经 RPC 调），到了记进 fired */
  remind(name: string, at: number) {
    this.schedule(name, at);
  }

  protected override scheduled = (name: string) => fire(this.ctx, name);

  fired() {
    return firedIn(this.ctx);
  }
}

export class TestCatalogBroadcast extends SynclineBroadcast<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, env.CATALOG);
  }

  /** 坏掉时收通知抛错（测试经 RPC 开关） */
  broken(value: boolean) {
    this.ctx.storage.kv.put('broken', value);
  }

  /** 再收 count 次通知就坏掉（之后收通知抛错，测试经 RPC 设）：模拟一轮送到、合并的下一轮没送到 */
  breakAfter(count: number) {
    this.ctx.storage.kv.put('healthy', count);
  }

  /** 接下来收到的 count 次通知一直不回（测试经 RPC 设）：模拟发的途中卡住 */
  hangNext(count: number) {
    this.ctx.storage.kv.put('hanging', count);
  }

  /** 还要卡住几次（测试据此知道通知已经发到这里、卡住了） */
  hangsLeft() {
    return this.ctx.storage.kv.get<number>('hanging') ?? 0;
  }

  override notify(round: Parameters<SynclineBroadcast['notify']>[0]) {
    if (this.ctx.storage.kv.get('broken')) throw new Error('分片出错');
    const healthy = this.ctx.storage.kv.get<number>('healthy');
    if (healthy !== undefined && healthy > 1) this.ctx.storage.kv.put('healthy', healthy - 1);
    else if (healthy !== undefined) {
      this.ctx.storage.kv.delete('healthy');
      this.ctx.storage.kv.put('broken', true);
    }
    const hanging = this.ctx.storage.kv.get<number>('hanging') ?? 0;
    if (hanging > 0) {
      this.ctx.storage.kv.put('hanging', hanging - 1);
      return new Promise<void>(() => undefined);
    }
    return super.notify(round);
  }
}

export class TestCatalogEntry extends SynclineSharedEntry<Env> {
  protected shared() {
    return this.env.CATALOG;
  }
}

/** 测试的 token：私有空间是「空间名.到期的毫秒数」，共用空间是「谁.到期的毫秒数」（admin 订阅全部的桶，别的订阅以它为名的桶），别的认不出 */
const identityOf = (token: string) => {
  const [name, expiresAt, ...rest] = token.split('.');
  return name && expiresAt && rest.length === 0 ? { name, expiresAt: Number(expiresAt) } : undefined;
};

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    if (new URL(request.url).pathname === '/catalog') {
      const route = { entry: ctx.exports.TestCatalogEntry, broadcast: env.CATALOG_BROADCAST, space: 'catalog', definition: catalog };
      return forwardShared(request, route, async (token) => {
        const identity = identityOf(token);
        return identity && { buckets: [[identity.name === 'admin' ? 'all' : identity.name]], expiresAt: identity.expiresAt };
      });
    }
    return forward(request, env.SPACE, async (token) => {
      const identity = identityOf(token);
      return identity && { space: identity.name, expiresAt: identity.expiresAt };
    });
  },
};
