import { expect, vi } from 'vitest';
import { Space } from '../cloud/space.ts';
import { slowestRate } from '../common/protocol.ts';
import { Device } from '../test/test-device.ts';
import { flush } from '../test/test-drive.ts';
import { rustLimits } from '../test/test-rust.ts';
import { createWorkout, tables, workout, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';

// 测试共用：一台同步过的设备连着替身 WebSocket（心跳与推送的测试用），计时器用 vitest 的假时钟

type Heartbeat = Awaited<ReturnType<typeof heartbeat>>;

/** 一条替身 WebSocket：记下发出的消息与有没有被关 */
function fakeSocket() {
  const record = { sent: [] as string[], closed: false, socket: {} as WebSocket };
  record.socket = Object.assign(record.socket, {
    readyState: WebSocket.CONNECTING,
    send: (message: string) => record.sent.push(message),
    close: () => {
      record.closed = true;
    },
  });
  return record;
}

/**
 * 一台同步过的设备连着一条替身 WebSocket（HTTP 拉取记下网址），计时器用 vitest 的假时钟；random 是退避的抖动，token 是接入方的 token()，
 * beforeSocket 在每次建 WebSocket 之前调（抛错就是建不出来）
 */
export async function heartbeat({
  random = () => 0,
  token = async () => 'valid',
  beforeSocket = () => undefined,
}: {
  random?: () => number;
  token?: () => Promise<string>;
  beforeSocket?: () => void;
} = {}) {
  const space = new Space(cloudStorage(createWorkout), tables);
  const device = new Device(deviceStorage(createWorkout), tables);
  const pulled = space.pull(device.private.pullRequest(), 1_000_000);
  if (!('cookie' in pulled)) throw new Error('应一块拉完');
  await device.private.receive(pulled);
  const sockets: { sent: string[]; closed: boolean; socket: WebSocket }[] = [];
  const fetched: string[] = [];
  const connection = new Connection(device.private, {
    url: 'https://sync.test/space',
    token,
    random,
    fetch: async (address: string) => {
      fetched.push(address);
      return new Response(JSON.stringify(space.pull(device.private.pullRequest(), 1_000_000)));
    },
    socket: () => {
      beforeSocket();
      const record = fakeSocket();
      sockets.push(record);
      return record.socket;
    },
  });
  connection.start();
  await flush();
  const open = () => {
    const socket = sockets.at(-1)?.socket as unknown as { readyState: number; onopen: () => void };
    socket.readyState = WebSocket.OPEN;
    socket.onopen();
  };
  const message = (data: string) => sockets.at(-1)?.socket.onmessage?.(new MessageEvent('message', { data }));
  const catchUp = () => message(JSON.stringify(space.pull(device.private.pullRequest(), 1_000_000)));
  /** 云端执行设备发出的第 index 条推送，把确认的通知送到设备 */
  const confirm = (index: number) => message(JSON.stringify(space.push(JSON.parse(sockets.at(-1)?.sent[index] ?? '[]'))));
  /** 云端执行设备的待上传、确认没送到设备（旧连接上推的） */
  const executedElsewhere = () => space.push(device.private.pending());
  /** 连上、补齐之后写一条约 30 万字节的写（汉字一个 3 字节：上传要的时间按字节算），推出去 */
  const pushBig = async () => {
    open();
    catchUp();
    await flush();
    await write(device, (tx) => tx.insert(workout).values({ id: 'big', note: '深'.repeat(100_000) }));
    await flush();
  };
  return { space, device, connection, sockets, fetched, open, message, catchUp, confirm, pushBig, executedElsewhere };
}

/** 等补齐或握手等到超时：假时钟走到核心的 receiveTimeout，第一条连接被关掉 */
export function receiveTimesOut({ sockets }: Heartbeat) {
  vi.advanceTimersByTime(rustLimits().receiveTimeout);
  expect(sockets[0]?.closed).toBe(true);
}

/** 退避到期：重连前先 HTTP 拉取一次 */
export async function pullsBeforeReconnect({ fetched }: Heartbeat) {
  vi.runOnlyPendingTimers();
  await vi.waitFor(() => expect(fetched).toHaveLength(1));
}

/** 连接断了之后：等过退避，新连接建出来、连上、补齐到 */
export async function reconnect({ sockets, open, catchUp }: Heartbeat) {
  vi.advanceTimersByTime(60_000);
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  open();
  catchUp();
  await flush();
}

/** 再过 ms 毫秒才发 ping，之前一条也不多发（sent 是这条连接发出的） */
export function pingsIn(sent: string[], ms: number) {
  const count = sent.length;
  vi.advanceTimersByTime(ms - 1);
  expect(sent).toHaveLength(count);
  vi.advanceTimersByTime(1);
  expect(sent.at(-1)).toBe('ping');
}

/** 第 index 条发出的推送按最慢的网传完、再空闲 25 秒才发 ping */
export const pingsAfterUpload = (sent: string[], index: number) =>
  pingsIn(sent, (new TextEncoder().encode(sent[index]).length / slowestRate) * 1000 + 25_000);
