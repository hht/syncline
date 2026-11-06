import { expect, test } from 'vitest';
import { flush } from '../test/test-drive.ts';
import { type Fetch, type Input, receiveTimeout, Shell } from './shell.ts';

// Verifies HTTP request execution on behalf of core: resets inactivity timer on each chunk and aborts stalled or cancelled requests.

/** Manual timer mock where armed contains active uncancelled callbacks. */
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

/** Mock streaming response where chunks are pushed incrementally and terminated by close. */
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
 * Test shell with mock core: emits fetch request 1 on 'go', aborts on 'stop', and records subsequent inputs in received.
 * signal captures the abort signal passed to fetch.
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

test('streaming response resets inactivity timer on each received chunk and completes without lingering timers', async () => {
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

test('aborts request on timeout if response headers stall or stream pauses mid-transfer, reporting failure to core', async () => {
  const silent = timers();
  const never = shell(() => Promise.withResolvers<Response>().promise, silent.schedule);
  silent.fire();
  await flush();
  expect(never.received).toEqual([{ type: 'failed', id: 1, error: expect.stringContaining('Pull timed out') }]);
  expect(never.signal()?.aborted).toBe(true);

  const stalled = timers();
  const { response, push } = streamed();
  const half = shell(async () => response, stalled.schedule);
  await push('{"patch":');
  stalled.fire();
  await flush();
  expect(half.received).toEqual([{ type: 'failed', id: 1, error: expect.stringContaining('Pull timed out') }]);
});

test('a fetch ignoring the abort that answers after the timeout leaves no timer armed and reports nothing more', async () => {
  const { armed, schedule, fire } = timers();
  const late = Promise.withResolvers<Response>();
  const { received } = shell(() => late.promise, schedule);
  fire();
  await flush();
  late.resolve(new Response('{"patch":[]}'));
  await flush();
  expect([received, armed.size]).toEqual([[{ type: 'failed', id: 1, error: expect.stringContaining('Pull timed out') }], 0]);
});

test('a request rejected with a value that is not an Error reports that value as text', async () => {
  const { schedule } = timers();
  const { received } = shell(() => Promise.reject('offline'), schedule);
  await flush();
  expect(received).toEqual([{ type: 'failed', id: 1, error: 'offline' }]);
});

test('stream decoder decodes multibyte UTF-8 characters split across chunk boundaries', async () => {
  const { schedule } = timers();
  const { response, push, close } = streamed();
  const { received } = shell(async () => response, schedule);
  const bytes = new TextEncoder().encode('{"note":"🎉"}');
  await push(bytes.slice(0, 10));
  await push(bytes.slice(10));
  await close();
  expect(received).toEqual([expect.objectContaining({ body: '{"note":"🎉"}' })]);
});

test('aborts fetch when core cancels request mid-stream on disconnect and drops remaining response', async () => {
  const { schedule } = timers();
  const { response, push } = streamed();
  const { received, send, signal } = shell(async () => response, schedule);
  await push('{"patch":');
  send({ type: 'stop' });
  await flush();
  expect(signal()?.aborted).toBe(true);
  expect(received).toEqual([]);
});

test('after close, inputs no longer reach the core: calls are answered "local database is closed", other inputs are dropped', () => {
  const inputs: string[] = [];
  const delivered: unknown[] = [];
  const closed = new Shell(
    {
      control(text: string) {
        inputs.push(text);
        return '[]';
      },
    },
    {},
    (instruction) => delivered.push(instruction),
  );
  closed.close();
  closed.send({ type: 'query', id: 3 });
  closed.send({ type: 'token', request: 1, token: 't' });
  expect(inputs).toEqual([]);
  expect(delivered).toEqual([{ type: 'reply', id: 3, error: { message: 'local database is closed' } }]);
});
