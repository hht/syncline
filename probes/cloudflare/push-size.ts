import { randomUUID } from 'node:crypto';
import { withWorker } from './deploy.ts';
import { connect, next, sleep, tailCalls } from './device.ts';

/**
 * 在真实的 Cloudflare 上量一条写多大时云端还执行得了：DO 每次调用的 CPU（默认 30 秒）与每个 isolate 的内存（128 MB）有上限，本地的 workerd 都不限，
 * 超了对象被重置、设备原样重推也一样。用 wrangler 当前登录的账号以一次性的名字部署 worker.ts，每档一个新空间：HTTP 拉一次拿游标、连上、
 * 推一条全是短行的写，收到通知或提示（执行了）算过，连接被关、超时算没过；wrangler tail 报出每次调用的 CPU 与墙钟时间、没过的原因（outcome，如 exceededCpu）。
 * 量完删掉 Worker（deploy.ts）。用法（仓库根）：node probes/cloudflare/push-size.ts [MiB …]，默认 1 2 4 6 8
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */

const sizes = process.argv.slice(2).map(Number);

/** 推一条约 bytes 字节的写：每行只有一个短主键，同样字节数里行数最多、解析出的对象最多 */
function mutation(bytes: number) {
  const row = (index: number) => ({ op: 'put', table: 't', row: { i: String(index) } });
  const rows = Math.floor(bytes / JSON.stringify(row(1e5)).length);
  return JSON.stringify([{ client: 'probe', id: 1, changes: Array.from({ length: rows }, (_, index) => row(index)) }]);
}

/** 推送之后的下一条：这次写的通知（确认到第 1 条、没被扣下）或提示（太大没拼，写已提交）才算执行了 */
function executed(message: string) {
  const reply = JSON.parse(message) as { hint?: unknown; lmids?: Record<string, number>; held?: unknown[] };
  return reply.hint !== undefined || (reply.lmids?.probe === 1 && !reply.held?.length);
}

/** 一档：执行了给出耗时，没执行给出关闭码、原因或收到的消息 */
async function attempt(url: string, secret: string, mib: number) {
  const token = `${randomUUID()}.${secret}`;
  let socket: WebSocket;
  try {
    socket = await connect(url, token);
  } catch (error) {
    return `${mib} MiB：${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    const text = mutation(mib * 1024 * 1024);
    const sentAt = performance.now();
    socket.send(text);
    const reply = await next(socket, 120_000);
    const result =
      'failure' in reply
        ? reply.failure
        : executed(reply.message)
          ? `执行了，${Math.round(performance.now() - sentAt)} ms`
          : `没执行：${reply.message.slice(0, 300)}`;
    return `${mib} MiB（${Buffer.byteLength(text)} 字节）：${result}`;
  } finally {
    socket.close();
  }
}

await withWorker('wrangler.jsonc', async ({ name, secret, url, onCleanUp }) => {
  await tailCalls(name, onCleanUp);
  for (const mib of sizes.length > 0 ? sizes : [1, 2, 4, 6, 8]) console.log(await attempt(url, secret, mib));
  // tail 的事件晚一阵才到
  await sleep(30_000);
});
