import { randomUUID } from 'node:crypto';
import { withWorker } from './deploy.ts';
import { connect, next, pull, sleep, tailCalls } from './device.ts';

/**
 * 在真实的 Cloudflare 上看 DO 超出 CPU 被平台中止时，同一轮里已执行的写有没有被提交：一批推送逐条执行，每条在自己的保存点里写完，
 * 隐式事务要等这一轮让出之后才提交（见 Space.push 的注释）。部署 worker.ts（deploy.ts，量完删掉），在一个新空间里推一批：
 * 第 1 条写一行 a，第 2 条写一行 b 与一行 spin（校验时一直空转，直到平台以超出 CPU 中止）。之后整份拉一次看云端有哪几行：
 * 都没有是整批回滚；有 a 是中止前提交了前面的写（之后被扣下的那条之前的都算已执行，设备不会重推，数据仍对）；
 * 有 b 是一条写只提交了一半（坏了数据）。wrangler tail 报出这次调用的结果（应是 exceededCpu）。
 * 用法（仓库根）：node probes/cloudflare/kill.ts [次数]，默认 3
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */

const times = Number(process.argv[2] ?? 3);

/** 一批两条写：a；b 与 spin */
const batch = JSON.stringify([
  { client: 'probe', id: 1, changes: [{ op: 'put', table: 't', row: { i: 'a' } }] },
  {
    client: 'probe',
    id: 2,
    changes: [
      { op: 'put', table: 't', row: { i: 'b' } },
      { op: 'put', table: 't', row: { i: 'spin' } },
    ],
  },
]);

/** 推一批、等它被中止，再整份拉一次：给出连接上的结果与云端有的行 */
async function attempt(url: string, secret: string) {
  const token = `${randomUUID()}.${secret}`;
  const socket = await connect(url, token);
  const sentAt = performance.now();
  socket.send(batch);
  const reply = await next(socket, 120_000);
  socket.close();
  const outcome = 'failure' in reply ? reply.failure : `收到 ${reply.message.slice(0, 200)}`;
  // 对象被重置后头几次请求可能还在重启
  await sleep(5000);
  const pulled = await pull(url, token);
  const rows = pulled.patch.filter(({ op }) => op === 'put').map((op) => ('row' in op ? (op.row as { i: string }).i : ''));
  return `${Math.round((performance.now() - sentAt) / 1000)} 秒后${outcome}；云端的行：${JSON.stringify(rows.sort())}`;
}

await withWorker('wrangler.jsonc', async ({ name, secret, url, onCleanUp }) => {
  await tailCalls(name, onCleanUp);
  for (let time = 1; time <= times; time += 1) console.log(`第 ${time} 次：${await attempt(url, secret)}`);
  await sleep(30_000);
});
