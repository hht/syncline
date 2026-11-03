import { expect, test } from 'vitest';
import { flush } from '../test/test-drive.ts';
import { type Fetch, type Input, receiveTimeout, Shell } from './shell.ts';

// 外壳替核心发 HTTP 请求：按「多久没收到数据」计时，慢慢在收就不打断，停住了才中止；核心撤掉的请求不再交回

/** 手动的计时器：armed 是排着、还没取消的 */
function timers() {
  const armed = new Set<() => void>();
  const schedule = (run: () => void, delay: number) => {
    expect(delay).toBe(receiveTimeout);
    armed.add(run);
    return () => armed.delete(run);
  };
  const fire = () => {
    const [run] = armed;
    armed.delete(run as () => void);
    run?.();
  };
  return { armed, schedule, fire };
}

/** 一个响应：body 按 push 一段段给出（文本或字节），close 结束 */
function streamed() {
  const { promise: started, resolve } = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const body = new ReadableStream<Uint8Array>({ start: resolve });
  return {
    response: new Response(body),
    push: async (text: string | Uint8Array) => {
      (await started).enqueue(typeof text === 'string' ? new TextEncoder().encode(text) : text);
      await flush();
    },
    close: async () => {
      (await started).close();
      await flush();
    },
  };
}

/**
 * 一个外壳，核心换成替身：收到 go 就要外壳发第 1 号请求，收到 stop 就撤掉它；外壳交给核心的其余事件记在 received 里。
 * signal 是请求带的中止信号
 */
function shell(fetch: Fetch, schedule: (run: () => void, delay: number) => () => void) {
  const received: Input[] = [];
  let signal: AbortSignal | undefined;
  const core = {
    control(text: string) {
      const input = JSON.parse(text) as Input;
      if (input.type === 'go') return JSON.stringify([{ type: 'fetch', request: 1, url: 'https://sync.test/space', headers: {} }]);
      if (input.type === 'stop') return JSON.stringify([{ type: 'abort', request: 1 }]);
      received.push(input);
      return '[]';
    },
  };
  const outer = new Shell(
    core,
    {
      fetch: (url, init) => {
        signal = init.signal;
        return fetch(url, init);
      },
      schedule,
    },
    () => undefined,
  );
  outer.send({ type: 'go' });
  return { received, send: (input: Input) => outer.send(input), signal: () => signal };
}

test('一段段收到的数据每段都重新计时：总共再久也读完，读完不留计时', async () => {
  const { armed, schedule } = timers();
  const { response, push, close } = streamed();
  const { received } = shell(async () => response, schedule);
  await push('{"patch":');
  expect(armed.size).toBe(1);
  await push('[]}');
  expect(armed.size).toBe(1);
  await close();
  expect(received).toEqual([{ type: 'response', request: 1, status: 200, body: '{"patch":[]}' }]);
  expect(armed.size).toBe(0);
});

test('响应头一直不来、或收到一半停住：到时中止请求，交给核心失败', async () => {
  const silent = timers();
  const never = shell(() => Promise.withResolvers<Response>().promise, silent.schedule);
  silent.fire();
  await flush();
  expect(never.received).toEqual([{ type: 'failed', id: 1, error: expect.stringContaining('拉取超时') }]);
  expect(never.signal()?.aborted).toBe(true);

  const stalled = timers();
  const { response, push } = streamed();
  const half = shell(async () => response, stalled.schedule);
  await push('{"patch":');
  stalled.fire();
  await flush();
  expect(half.received).toEqual([{ type: 'failed', id: 1, error: expect.stringContaining('拉取超时') }]);
});

test('一个字的 UTF-8 字节分在两段里：边收边解码照样解出', async () => {
  const { schedule } = timers();
  const { response, push, close } = streamed();
  const { received } = shell(async () => response, schedule);
  const bytes = new TextEncoder().encode('{"note":"深蹲"}');
  await push(bytes.slice(0, 10));
  await push(bytes.slice(10));
  await close();
  expect(received).toEqual([expect.objectContaining({ body: '{"note":"深蹲"}' })]);
});

test('收到一半时核心撤掉了请求（连接停了）：中止它，结果不再交给核心', async () => {
  const { schedule } = timers();
  const { response, push } = streamed();
  const { received, send, signal } = shell(async () => response, schedule);
  await push('{"patch":');
  send({ type: 'stop' });
  await flush();
  expect(signal()?.aborted).toBe(true);
  expect(received).toEqual([]);
});
