import { randomUUID } from 'node:crypto';
import { sharedWriteRows } from '../../src/common/limits.ts';
import { untilJson, withWorker, wrangler } from './deploy.ts';

/**
 * 在真实的 Cloudflare 上量共用空间一次后台写的 CPU：每改到一个桶，这次写就多记 1 到 2 行桶的行数，行各在不同桶时最多；
 * 本地的 workerd 不限 CPU、量不出。部署 shared-worker.ts（deploy.ts，量完删掉），在一个新空间里等桶行数数完，
 * 依次做三次 rows 行的写：spread（各进一个新桶）、move（各从一个桶挪到另一个新桶）、same（都进同一个桶，作对照）。
 * CPU 从 GraphQL 分析接口取（每次调用的 CPU 与墙钟），要在删掉 Worker 之前取：删了之后它的数据也查不到了。
 * 实时日志（wrangler tail）里没有会调别的 DO 的那些调用（后台写要发给广播分片），量不了。
 * 用法（仓库根）：node probes/cloudflare/shared-write.ts [行数]，默认共用空间一次写的上限 sharedWriteRows（超了云端拒收）
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 * @see https://developers.cloudflare.com/analytics/graphql-api/
 */

const rows = Number(process.argv[2] ?? sharedWriteRows);
const space = randomUUID();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一次调用（同一秒、同一对象、同一种的合成一组，调用少时一组就是一次）；CPU、墙钟的单位是微秒 */
type Invocation = {
  sum: { requests: number };
  dimensions: { datetime: string; namespaceId: string; objectId: string; type: string };
  quantiles: { cpuTimeP999: number; wallTimeP50: number };
};

/**
 * 账号里从 since 起的每次 DO 调用：令牌用 wrangler 当前登录的（输出的最后一行）。不按 Worker 过滤：
 * 分析数据里这些调用的 scriptName 记成 __unknown__，按名字查不到
 */
async function invocations(account: string, since: string) {
  const token = wrangler('auth', 'token').trim().split('\n').at(-1);
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query($a: String!, $since: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        durableObjectsInvocationsAdaptiveGroups(limit: 5000, filter: { datetime_geq: $since }, orderBy: [datetime_ASC]) {
          sum { requests } dimensions { datetime namespaceId objectId type } quantiles { cpuTimeP999 wallTimeP50 } } } } }`,
      variables: { a: account, since },
    }),
  });
  const body = (await response.json()) as {
    data?: { viewer: { accounts: { durableObjectsInvocationsAdaptiveGroups: Invocation[] }[] } };
    errors?: unknown;
  };
  if (!body.data) throw new Error(`分析接口出错：${JSON.stringify(body.errors)}`);
  return body.data.viewer.accounts[0]?.durableObjectsInvocationsAdaptiveGroups ?? [];
}

/** 三次写各是一次 CPU 至少 100 毫秒的调用 */
const heavy = (group: Invocation) => group.quantiles.cpuTimeP999 >= 100_000;

/**
 * 分析数据晚 7 到 13 分钟、分几批才到（广播分片的调用先到，共用空间的几次写更晚），调用次数一时不变不说明到齐了：
 * 每分钟查一次，等到三次写都在（至多 20 分钟）
 */
async function settled(account: string, since: string) {
  for (let tries = 0; tries < 20; tries += 1) {
    await sleep(60_000);
    const groups = await invocations(account, since);
    console.log(`  分析接口：已记下 ${groups.reduce((sum, group) => sum + group.sum.requests, 0)} 次 DO 调用`);
    if (groups.filter(heavy).length >= 3) return groups;
  }
  throw new Error('20 分钟内分析数据里没有三次写');
}

/** 打出 CPU 至少 100 毫秒的调用（三次写，按时刻对上），其余只报个数 */
function report(groups: Invocation[]) {
  console.log('CPU 至少 100 ms 的 DO 调用（时刻 UTC、命名空间、对象、种类、CPU、墙钟）：');
  for (const { dimensions, sum, quantiles } of groups.filter(heavy))
    console.log(
      `  ${dimensions.datetime.slice(11, 19)} ${dimensions.namespaceId.slice(0, 8)} ${dimensions.objectId.slice(0, 8)} ${dimensions.type}${sum.requests > 1 ? ` ×${sum.requests}` : ''}：CPU ${Math.round(quantiles.cpuTimeP999 / 1000)} ms，墙钟 ${Math.round(quantiles.wallTimeP50 / 1000)} ms`,
    );
  console.log(`共 ${groups.reduce((sum, group) => sum + group.sum.requests, 0)} 次 DO 调用`);
}

const accounts = JSON.parse(wrangler('whoami', '--json')) as { accounts: { id: string }[] };
const [account] = accounts.accounts;
if (!account || accounts.accounts.length > 1) throw new Error('wrangler 登录的不是恰好一个账号');
const since = new Date().toISOString();
await withWorker('shared-wrangler.jsonc', async ({ secret, url }) => {
  const target = (path: string, query: Record<string, string> = {}) => `${url}${path}?${new URLSearchParams({ space, secret, ...query })}`;
  // 新空间打开时登记数桶行数，alarm 里数完（表是空的，一步就完）
  for (let waited = 0; !(await untilJson(target('/counted'))); waited += 1) {
    if (waited === 30) throw new Error('60 秒内桶行数没数完');
    await sleep(2000);
  }
  for (const kind of ['spread', 'move', 'same']) {
    const startedAt = performance.now();
    const at = new Date().toISOString().slice(11, 19);
    // 写只发一次：超了 CPU 或被拒收时回错误页，重发会把同一次写再做一遍
    const response = await fetch(target('/write', { kind, rows: String(rows) }));
    const took = Math.round(performance.now() - startedAt);
    console.log(`${at} ${kind} ${rows} 行：${response.ok ? '写完并发完通知' : `出错 ${response.status}`}，客户端量的往返 ${took} ms`);
    // 两次之间隔开，分析数据里按时刻分得清
    await sleep(10_000);
  }
  report(await settled(account.id, since));
});
