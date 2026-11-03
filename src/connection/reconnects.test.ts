import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { Server } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import { parsePullBody, parsePullRequest } from '../common/pull-url.ts';
import { Device } from '../test/test-device.ts';
import { drain } from '../test/test-drive.ts';
import { type Cloud, type CloudEnd, Network } from '../test/test-network.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';
import { expectConnected } from './test-status.ts';

// 一齐重连怎么摊开：分片按连着的设备数给出重连的随机窗口（spread），断了之后设备在窗口里随机等；
// 身份快到期前设备自己换 token 重连（云端在补齐里给 expiresIn），不攒到下一次通知时被一起关掉

const note = sqliteTable('note', { id: text().primaryKey() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY)';

/**
 * 云端的补齐另带 extra；记下连接排的每个计时与取了几次 token。抖动取最大（random 为 1），看得出窗口的上限。
 * token 是第 n 次取 token 给什么（默认都是 valid）；accept 换掉云端接受连接的做法
 */
function setup(
  extra: Record<string, unknown>,
  {
    token = () => 'valid',
    accept,
    schedule: timers = 'network',
  }: { token?: (n: number) => string | Error; accept?: Cloud['accept']; schedule?: 'network' | 'default' } = {},
) {
  const space = new Space(cloudStorage(createNote), [note]);
  const network: Network = new Network(
    (items) => items[0],
    () => ({
      accept: (socket, url, expiresAt) => {
        if (accept) return accept(socket, url, expiresAt);
        const send = socket.send.bind(socket);
        socket.send = (message: string) => send(JSON.stringify({ ...JSON.parse(message), ...extra }));
        server.accept(socket, parsePullRequest(url).cookie, expiresAt);
        socket.send = send;
      },
      receive: (socket, message) => server.receive(socket, message),
      pull: (_url, body) => server.pull(parsePullBody(body ?? '')),
    }),
  );
  const server: Server<CloudEnd> = new Server(network.sockets(), space);
  const { schedule, ...options } = network.options(0);
  const scheduled: { delay: number; run: () => void }[] = [];
  let tokens = 0;
  const connection = new Connection(new Device(deviceStorage(createNote), [note]).private, {
    url: 'https://sync.test/space',
    ...options,
    token: async () => {
      tokens += 1;
      const given = token(tokens);
      if (given instanceof Error) throw given;
      return given;
    },
    ...(timers === 'network' && {
      schedule: (run: () => void, delay: number) => {
        scheduled.push({ delay, run });
        return schedule(run, delay);
      },
    }),
    random: () => 1,
  });
  return { network, connection, scheduled, tokens: () => tokens };
}

test('云端给了重连的窗口（spread，分片按连着的设备数给）：断了之后在 0 到这个窗口之间随机等，不挤在 1 秒内一齐重连（部署断开全部连接时）', async () => {
  const { network, connection, scheduled } = setup({ spread: 8000 });
  connection.start();
  await drain(network);
  expect(connection.status().connected).toBe(true);
  network.breakOne();
  expect(scheduled.at(-1)?.delay).toBe(8000);
  connection.stop();
});

test('云端在补齐里给了身份还有多久到期（expiresIn）：到期前 1 到 4 分钟之间随机挑一刻，自己换新 token 重连，不等到期被云端关掉', async () => {
  const { network, connection, scheduled, tokens } = setup({ expiresIn: 600_000 });
  connection.start();
  await drain(network);
  const renew = scheduled.find(({ delay }) => delay === 600_000 - 60_000 - 180_000);
  expect(renew).toBeDefined();
  expect(tokens()).toBe(1);
  renew?.run();
  await drain(network);
  expect(tokens()).toBe(2);
  expectConnected(connection);
  connection.stop();
});

test('云端给的到期时刻很远（超过 setTimeout 能排的 2^31-1 毫秒）：不当作 0、不一连上就反复重连', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { network, connection, tokens } = setup({ expiresIn: 2 ** 40 }, { schedule: 'default' });
    connection.start();
    await drain(network, { advance: false });
    expect(connection.status().connected).toBe(true);
    vi.advanceTimersByTime(10);
    await drain(network, { advance: false });
    expect(tokens()).toBe(1);
    connection.stop();
  } finally {
    vi.useRealTimers();
  }
});
