import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { forward, SynclineSpace } from '../../src/cloudflare/index.ts';

// 量平台限制用的临时 Worker（push-size.ts、kill.ts、cascade.ts 部署、量完删掉）：一个私有空间。
// token 是「空间名.SECRET」，SECRET 部署时随机定，部署着的这几分钟里别人连不上

type Env = { SPACE: DurableObjectNamespace<ProbeSpace>; SECRET: string };

/** push-size、kill 推的表：只有主键 */
const t = sqliteTable('t', { i: text().primaryKey() });
/** cascade 用：父表，与没有别的索引的窄子表、8 个索引的宽子表（子表引用父表，删父行连带删子行） */
const parent = sqliteTable('parent', { id: text().primaryKey() });
const narrow = sqliteTable('narrow', { id: text().primaryKey(), parent_id: text().references(() => parent.id) });
const columns = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'p', 'q', 'r', 's', 'u', 'v', 'w', 'x'] as const;
const indexed = columns.slice(0, 8);
const wide = sqliteTable(
  'wide',
  {
    id: text().primaryKey(),
    parent_id: text().references(() => parent.id),
    ...Object.fromEntries(columns.map((column) => [column, text()])),
  },
  (table) => indexed.map((column) => index(`wide_${column}`).on(table[column as keyof typeof table] as never)),
);
const schema = { t, parent, narrow, wide };
type Child = 'narrow' | 'wide';

/** 主键以 spin 开头的 t 行校验时一直空转，直到平台以超出 CPU 中止（kill.ts 用：Workers 里同步执行时 Date.now 不走，按次数转） */
const spinning = {
  '~standard': {
    version: 1 as const,
    vendor: 'probe',
    validate(value: unknown) {
      let hash = 0;
      if ((value as { i: string }).i.startsWith('spin')) for (let turn = 0; turn < 1e13; turn += 1) hash = (hash * 31 + turn) | 0;
      return hash === 1 ? { issues: [{ message: '不会到这里' }] } : { value };
    },
  },
};

/** 一行子表：宽表每列 32 个字符 */
const childRow = (child: Child, id: string) =>
  child === 'narrow'
    ? { id, parent_id: 'p' }
    : { id, parent_id: 'p', ...Object.fromEntries(columns.map((column) => [column, `${column}${id}`.padEnd(32, '.')])) };

export class ProbeSpace extends SynclineSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, schema, { validation: new Map([[t, spinning]]) });
  }

  /** 服务端写父行 p 与 child 表的第 from 到 from + count - 1 行（cascade.ts 一批批灌数据） */
  seed(child: Child, from: number, count: number) {
    this.mutate((tx) => {
      tx.upsert(parent, { id: 'p' });
      for (let n = from; n < from + count; n += 1) tx.insert(schema[child], childRow(child, String(n)));
    });
  }
}

export default {
  fetch: async (request, env) => {
    const url = new URL(request.url);
    // 灌数据：/seed?space=&secret=&child=&from=&count=
    if (url.pathname === '/seed') {
      const get = (name: string) => url.searchParams.get(name) ?? '';
      if (!env.SECRET || get('secret') !== env.SECRET) return new Response(null, { status: 401 });
      await env.SPACE.getByName(get('space')).seed(get('child') as Child, Number(get('from')), Number(get('count')));
      return Response.json({ ok: true });
    }
    return forward(request, env.SPACE, async (token) => {
      const [space, secret] = token.split('.');
      // 没设 SECRET（不经探针部署）时一律拒绝
      return space && env.SECRET && secret === env.SECRET ? { space, expiresAt: Date.now() + 3_600_000 } : undefined;
    });
  },
} satisfies ExportedHandler<Env>;
