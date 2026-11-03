import { spawn } from 'node:child_process';
import { bearer, type Chunk, type Op, type Poke, subprotocol } from '../../src/common/protocol.ts';
import { pullBody, pullURL } from '../../src/common/pull-url.ts';
import { untilJson, wranglerBin } from './deploy.ts';

/**
 * 探针当一台设备：HTTP 整份拉、连上 WebSocket、等下一条消息；另用 wrangler tail 报出平台记下的每次调用的 CPU。
 * 不该知道的：量什么、Worker 怎么部署
 */

/** HTTP 整份拉一次（分块的接着拉到末块）：私有空间的拉取是 POST，请求在正文里（与设备的 pulling.ts 一样）；给出末块，改动是各块的合起来 */
export async function pull(url: string, token: string): Promise<Poke> {
  const patch: Op[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = (await untilJson(pullURL(url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: pullBody({ cookie: null, ...(cursor !== undefined && { cursor }) }),
    })) as Poke | Chunk;
    patch.push(...result.patch);
    if ('cookie' in result) return { ...result, patch };
    cursor = result.next;
  }
}

/** 连接上的下一件事：消息（给出内容）、关闭或超时（给出原因），先到的算 */
export function next(socket: WebSocket, ms: number) {
  return new Promise<{ message: string } | { failure: string }>((resolve) => {
    const timer = setTimeout(() => done({ failure: `${ms / 1000} 秒没有回音` }), ms);
    const done = (result: { message: string } | { failure: string }) => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      resolve(result);
    };
    const onMessage = ({ data }: MessageEvent) => done({ message: String(data) });
    const onClose = ({ code, reason }: CloseEvent) => done({ failure: `连接被关 ${code} ${reason}` });
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
  });
}

/** 整份拉一次拿游标、连上、收下补齐：给出连接，补齐没来抛错 */
export async function connect(url: string, token: string) {
  const pulled = await pull(url, token);
  const socket = new WebSocket(pullURL(url.replace(/^http/, 'ws'), { cookie: pulled.cookie }), [subprotocol, `${bearer}${token}`]);
  const caughtUp = await next(socket, 30_000);
  if ('failure' in caughtUp) {
    socket.close();
    throw new Error(`连上之后没有补齐：${caughtUp.failure}`);
  }
  return socket;
}

/**
 * 跟着 Worker 的实时日志，平台记下的调用里 CPU 超过 100 毫秒或结果不是 ok 的（如 exceededCpu）打出来；onCleanUp 登记删 Worker 前停掉它。
 * tail 连上时什么也不打：等 5 秒再返回，之后的调用才不漏；事件晚一阵才到，量完要再等一会
 */
export async function tailCalls(name: string, onCleanUp: (stop: () => void) => void) {
  const tail = spawn(wranglerBin, ['tail', name, '--format', 'json'], { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'inherit'] });
  onCleanUp(() => tail.kill());
  let logged = '';
  tail.stdout?.on('data', (chunk: Buffer) => {
    logged += chunk.toString();
    const event = /"wallTime":\s*(\d+),\s*"cpuTime":\s*(\d+),[\s\S]*?"outcome":\s*"(\w+)"/g;
    let last = 0;
    for (const match of logged.matchAll(event)) {
      const [text, wall, cpu, outcome] = match;
      if (Number(cpu) > 100 || outcome !== 'ok') console.log(`平台记下：${outcome}，CPU ${cpu} ms，墙钟 ${wall} ms`);
      last = match.index + text.length;
    }
    logged = logged.slice(last);
  });
  await sleep(5000);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
