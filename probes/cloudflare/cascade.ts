import { randomUUID } from 'node:crypto';
import { writeRows } from '../../src/common/limits.ts';
import { untilJson, withWorker } from './deploy.ts';
import { connect, next, sleep, tailCalls } from './device.ts';

/**
 * 在真实的 Cloudflare 上量一条在上限内、最费 CPU 的写：删一行父行连带删满一次写的上限（writeRows 行，连带删的也算），
 * 子表分没有别的索引的窄表与 8 个索引、16 列各 32 字符的宽表；另推一条约 8 MiB、全是宽表短行的插入（行最多、每行要写 8 个索引）。
 * 部署 worker.ts（deploy.ts，量完删掉），每种在一个新空间里由服务端分批写好子行，设备推这一条写，收到确认（没被扣下）算执行了；
 * wrangler tail 报出每次调用的 CPU（灌数据的也在里面，CPU 低于 100 毫秒的不打）。DO 每次调用默认至多 30 秒 CPU，超了对象被重置、
 * 设备原样重推也一样，这条写永远推不上去。用法（仓库根）：node probes/cloudflare/cascade.ts [子行数]，默认 writeRows - 1
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */

/** 子表：没有别的索引的窄表、8 个索引的宽表（worker.ts） */
type Child = 'narrow' | 'wide';

const children = Number(process.argv[2] ?? writeRows - 1);
const seedBatch = 10_000;

/** 推一条写（changes）等确认：给出耗时或没执行的原因 */
async function push(url: string, token: string, changes: unknown[]) {
  const socket = await connect(url, token);
  try {
    const text = JSON.stringify([{ client: 'probe', id: 1, changes }]);
    const sentAt = performance.now();
    socket.send(text);
    const reply = await next(socket, 180_000);
    if ('failure' in reply) return reply.failure;
    const confirmed = JSON.parse(reply.message) as { hint?: unknown; lmids?: Record<string, number>; held?: unknown[] };
    const executed = confirmed.hint !== undefined || (confirmed.lmids?.probe === 1 && !confirmed.held?.length);
    return executed
      ? `执行了，${Math.round(performance.now() - sentAt)} ms（${Buffer.byteLength(text)} 字节）`
      : `没执行：${reply.message.slice(0, 300)}`;
  } finally {
    socket.close();
  }
}

/** 删父行连带删 child 表的 children 行 */
async function cascade(url: string, secret: string, child: Child) {
  const space = randomUUID();
  for (let from = 0; from < children; from += seedBatch) {
    const count = Math.min(seedBatch, children - from);
    await untilJson(`${url}/seed?${new URLSearchParams({ space, secret, child, from: String(from), count: String(count) })}`);
  }
  const result = await push(url, `${space}.${secret}`, [{ op: 'del', table: 'parent', key: { id: 'p' } }]);
  return `删父行连带删 ${children} 行 ${child}：${result}`;
}

/** 约 8 MiB 的宽表插入：8 个索引列各一个短值，其余列不给 */
async function widePut(url: string, secret: string) {
  const row = (n: number) => ({
    op: 'put',
    table: 'wide',
    row: Object.fromEntries([['id', String(n)], ...'abcdefgh'.split('').map((c) => [c, `${c}${n}`])]),
  });
  const rows = Math.min(writeRows, Math.floor((8 * 1024 * 1024) / JSON.stringify(row(1e5)).length));
  const result = await push(
    url,
    `${randomUUID()}.${secret}`,
    Array.from({ length: rows }, (_, n) => row(n)),
  );
  return `插入 ${rows} 行宽表（8 个索引）：${result}`;
}

await withWorker('wrangler.jsonc', async ({ name, secret, url, onCleanUp }) => {
  await tailCalls(name, onCleanUp);
  console.log(await widePut(url, secret));
  for (const child of ['narrow', 'wide'] as const) console.log(await cascade(url, secret, child));
  await sleep(30_000);
});
