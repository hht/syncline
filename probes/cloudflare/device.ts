import { spawn } from 'node:child_process';
import { bearer, type Chunk, type Op, type Poke, subprotocol } from '../../src/common/protocol.ts';
import { pullBody, pullURL } from '../../src/common/pull-url.ts';
import { untilJson, wranglerBin } from './deploy.ts';

/**
 * Simulates a client device for probes: performs full HTTP pulls, connects via WebSocket,
 * and waits for incoming messages, using wrangler tail to report invocation CPU times logged by the platform.
 * Out of scope: what is probed or how the Worker is deployed.
 */

/** Performs a full HTTP pull, chaining chunks to the final chunk with combined patches, using POST with request body for private spaces. */
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

/** Awaits the next WebSocket event (message, close, or timeout), resolving with whichever arrives first. */
export function next(socket: WebSocket, ms: number) {
  return new Promise<{ message: string } | { failure: string }>((resolve) => {
    const timer = setTimeout(() => done({ failure: `no response after ${ms / 1000} seconds` }), ms);
    const done = (result: { message: string } | { failure: string }) => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      resolve(result);
    };
    const onMessage = ({ data }: MessageEvent) => done({ message: String(data) });
    const onClose = ({ code, reason }: CloseEvent) => done({ failure: `connection closed ${code} ${reason}` });
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
  });
}

/** Performs a full pull to obtain a cookie, establishes a WebSocket connection, and awaits catch-up, throwing if catch-up fails. */
export async function connect(url: string, token: string) {
  const pulled = await pull(url, token);
  const socket = new WebSocket(pullURL(url.replace(/^http/, 'ws'), { cookie: pulled.cookie }), [subprotocol, `${bearer}${token}`]);
  const caughtUp = await next(socket, 30_000);
  if ('failure' in caughtUp) {
    socket.close();
    throw new Error(`No catch-up received after connect: ${caughtUp.failure}`);
  }
  return socket;
}

/**
 * Tails live Worker logs, reporting invocations with CPU time over 100 ms or non-ok outcomes such as exceededCpu, registering process cleanup with onCleanUp.
 * Waits 5 seconds before returning to avoid missing subsequent invocations while tail connects; events arrive with a delay, so callers wait briefly after probing finishes.
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
      if (Number(cpu) > 100 || outcome !== 'ok') console.log(`platform logged: ${outcome}, CPU ${cpu} ms, wall ${wall} ms`);
      last = match.index + text.length;
    }
    logged = logged.slice(last);
  });
  await sleep(5000);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
