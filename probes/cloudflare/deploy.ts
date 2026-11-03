import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 探针用的一次性 Worker：用 wrangler 当前登录的账号以一次性的名字部署（带部署时随机定的 SECRET，部署着的这几分钟里别人调不动），
 * 量完删掉；出错、Ctrl-C、关掉终端也删。不该知道的：量什么、怎么量
 */

const here = import.meta.dirname;
// 直接跑包里的 wrangler：经 npx 起的 tail 杀不掉 npx 底下的进程，脚本就退不出去
export const wranglerBin = join(here, '../../node_modules/.bin/wrangler');
export const wrangler = (...args: string[]) => execFileSync(wranglerBin, args, { cwd: here, encoding: 'utf8' });

/** 部署好的 Worker：onCleanUp 登记删 Worker 之前要先停的（如 wrangler tail） */
type Deployed = { name: string; secret: string; url: string; onCleanUp: (stop: () => void) => void };

/** 部署 config（本目录里的 wrangler 配置）交给 measure，量完删掉 */
export async function withWorker(config: string, measure: (worker: Deployed) => Promise<void>) {
  const name = `syncline-probe-${randomUUID().slice(0, 8)}`;
  const secret = randomUUID();
  const stops: (() => void)[] = [];
  let cleaned = false;
  // 还没部署上也照删，报错不管；只删一次（删的途中又按 Ctrl-C 不再删第二遍）
  const cleanUp = () => {
    if (cleaned) return;
    cleaned = true;
    for (const stop of stops) stop();
    try {
      wrangler('delete', '--name', name, '--force');
    } catch (error) {
      console.error(`删 Worker ${name} 出错，到 Cloudflare 后台手动删：${error}`);
    }
    rmSync(join(here, '.wrangler'), { recursive: true, force: true });
  };
  // Ctrl-C、关掉终端默认直接退出、不走 finally
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(signal, () => {
      cleanUp();
      process.exit(130);
    });
  try {
    const deployed = wrangler('deploy', '--config', config, '--name', name, '--var', `SECRET:${secret}`);
    const url = /https:\/\/\S+\.workers\.dev/.exec(deployed)?.[0];
    if (!url) throw new Error(`部署的输出里没有网址：\n${deployed}`);
    await measure({ name, secret, url, onCleanUp: (stop) => stops.push(stop) });
  } finally {
    cleanUp();
  }
}

/** 请求刚部署的 Worker：头几秒可能回错误页（平台记下的是 exception，原因没查清），等到回 JSON（至多 60 秒） */
export async function untilJson(url: string, init?: RequestInit) {
  for (let tries = 0; ; tries += 1) {
    const response = await fetch(url, init);
    const text = await response.text();
    if (response.headers.get('Content-Type')?.includes('json')) return JSON.parse(text) as unknown;
    if (tries === 30) throw new Error(`回的不是 JSON：${response.status} ${text.slice(0, 200)}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
