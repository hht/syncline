import { expect, test, vi } from 'vitest';
import { socketLimit } from '../common/protocol.ts';
import { flush, withFakeTimers } from '../test/test-drive.ts';
import { rustLimits } from '../test/test-rust.ts';
import { workout, write } from '../test/test-schema.ts';
import { heartbeat, pingsAfterUpload, pingsIn, pullsBeforeReconnect, receiveTimesOut, reconnect } from './test-connection.ts';

// Uploads and heartbeat: push batches bounded by byte size; ping suppressed during upload based on slowest rate estimate,
// resetting idle window when confirmation arrives on the active socket.

test('heartbeat: suppresses ping during large push batch upload based on slowest rate estimate; pings after 25s idle upon completion', () =>
  withFakeTimers(async () => {
    const { connection, sockets, message, pushBig } = await heartbeat();
    await pushBig();
    const bytes = new TextEncoder().encode(sockets[0]?.sent[0]).length;
    expect(sockets[0]?.sent).toHaveLength(1);
    // At 1 KB/s, takes ~300s: incoming messages during upload do not trigger premature pings or disconnects.
    const done = (bytes / rustLimits().slowestRate) * 1000;
    vi.advanceTimersByTime(done - 10_000);
    message('pong');
    vi.advanceTimersByTime(10_000 - 1);
    expect(sockets[0]?.sent).toHaveLength(1);
    expect(sockets[0]?.closed).toBe(false);
    pingsIn(sockets[0]?.sent ?? [], 25_001);
    connection.stop();
  }));

test('bounds push batch size at half of WebSocket message byte limit: splits three ~8 KB mutations into 2 and 1', async () => {
  const { device, connection, sockets, open } = await heartbeat();
  const third = '€'.repeat(Math.ceil(socketLimit / 9));
  for (const id of ['n1', 'n2', 'n3']) await write(device, (tx) => tx.insert(workout).values({ id, note: third }));
  // Batches buffered mutations under limit when socket opens.
  open();
  await flush();
  expect(sockets[0]?.sent).toHaveLength(1);
  expect(JSON.parse(sockets[0]?.sent[0] ?? '[]')).toHaveLength(2);
  connection.stop();
});

test('heartbeat: suppresses ping during initial upload of offline accumulated batch upon connection open', () =>
  withFakeTimers(async () => {
    const { device, connection, sockets, open, catchUp } = await heartbeat();
    await write(device, (tx) => tx.insert(workout).values({ id: 'big', note: '€'.repeat(100_000) }));
    open();
    catchUp();
    await flush();
    pingsAfterUpload(sockets[0]?.sent ?? [], 0);
    connection.stop();
  }));

test('heartbeat: recalculates ping suppression window when previous batch confirms and next batch starts', () =>
  withFakeTimers(async () => {
    const { device, connection, sockets, open, catchUp, confirm } = await heartbeat();
    // Two large mutations each form a batch: first ~30 KB (~30s), second ~300 KB (~300s).
    await write(device, (tx) => tx.insert(workout).values({ id: 'mid', note: '€'.repeat(10_000) }));
    await write(device, (tx) => tx.insert(workout).values({ id: 'big', note: '€'.repeat(100_000) }));
    open();
    catchUp();
    await flush();
    confirm(0);
    await flush();
    expect(sockets[0]?.sent).toHaveLength(2);
    pingsAfterUpload(sockets[0]?.sent ?? [], 1);
    connection.stop();
  }));

test('heartbeat: pushing small batch before catch-up does not cancel catch-up timeout; pulls before next reconnect', () =>
  withFakeTimers(async () => {
    const harness = await heartbeat();
    const { device, connection, sockets, open } = harness;
    // ~5 KB, estimated ~5s upload time.
    await write(device, (tx) => tx.insert(workout).values({ id: 'big', note: '€'.repeat(1700) }));
    open();
    await flush();
    expect(sockets[0]?.sent).toHaveLength(1);
    receiveTimesOut(harness);
    await pullsBeforeReconnect(harness);
    connection.stop();
  }));

test('heartbeat: confirms large push batch before estimate expires, pinging after 25s idle from confirmation', () =>
  withFakeTimers(async () => {
    const { device, connection, sockets, confirm, pushBig } = await heartbeat();
    await pushBig();
    vi.advanceTimersByTime(2_000);
    confirm(0);
    await flush();
    expect(device.private.pending()).toEqual([]);
    pingsIn(sockets[0]?.sent ?? [], 25_000);
    connection.stop();
  }));

test('heartbeat: awaits upload estimate for retransmitted batch even if catch-up already confirmed it from prior connection', () =>
  withFakeTimers(async () => {
    const { device, connection, sockets, open, catchUp, executedElsewhere } = await heartbeat();
    await write(device, (tx) => tx.insert(workout).values({ id: 'big', note: '€'.repeat(100_000) }));
    executedElsewhere();
    open();
    await write(device, (tx) => tx.insert(workout).values({ id: 'small' }));
    catchUp();
    await flush();
    // Catch-up confirms prior execution; device pushes next small batch: pings suppressed until both finish.
    expect(sockets[0]?.sent).toHaveLength(2);
    const [big = '', small = ''] = sockets[0]?.sent ?? [];
    const bytes = new TextEncoder().encode(big).length + new TextEncoder().encode(small).length;
    pingsIn(sockets[0]?.sent ?? [], (bytes / rustLimits().slowestRate) * 1000 + 25_000);
    connection.stop();
  }));

test('heartbeat: late execution of large batch from previous connection arriving on new socket still honors upload estimate', () =>
  withFakeTimers(async () => {
    const harness = await heartbeat();
    const { space, connection, sockets, message, pushBig } = harness;
    await pushBig();
    sockets[0]?.socket.onclose?.(new CloseEvent('close', { code: 1006 }));
    await reconnect(harness);
    message(JSON.stringify(space.push(JSON.parse(sockets[0]?.sent[0] ?? '[]'))));
    await flush();
    pingsAfterUpload(sockets[1]?.sent ?? [], 0);
    connection.stop();
  }));

test('heartbeat: confirmation of post-resync batch resets ping timer immediately (not a retransmission of old client)', () =>
  withFakeTimers(async () => {
    const harness = await heartbeat();
    const { device, connection, sockets, confirm, pushBig } = harness;
    await pushBig();
    sockets[0]?.socket.onclose?.(new CloseEvent('close', { code: 1006 }));
    await device.private.resync(true);
    await reconnect(harness);
    await write(device, (tx) => tx.insert(workout).values({ id: 'small' }));
    await flush();
    confirm(0);
    await flush();
    pingsIn(sockets[1]?.sent ?? [], 25_000);
    connection.stop();
  }));

// Max jitter (random 1): each reconnect waits exactly the backoff bound for that attempt.
test.each([
  {
    name: 'persistent push rejection (1011): exponential backoff continues across reconnects without resetting on catch-up',
    pending: true,
    closes: [
      { code: 1011, wait: 1000 },
      { code: 1011, wait: 2000 },
      { code: 1011, wait: 4000 },
    ],
  },
  {
    // Catch-up with nothing pending resets backoff, so a plain retry would wait 1s and evict whichever device took the slot,
    // which then does the same.
    name: 'evicted for too many connections (1008) right after catching up: reconnects within the maximum backoff, then the first again once caught up',
    pending: false,
    closes: [
      { code: 1008, wait: rustLimits().maxDelay },
      { code: 1006, wait: rustLimits().baseDelay },
    ],
  },
])('$name', ({ pending, closes }) =>
  withFakeTimers(async () => {
    const { device, connection, sockets, open, catchUp } = await heartbeat({ random: () => 1 });
    if (pending) await write(device, (tx) => tx.insert(workout).values({ id: 'w1' }));
    for (const { code, wait } of closes) {
      open();
      catchUp();
      await flush();
      sockets.at(-1)?.socket.onclose?.(new CloseEvent('close', { code }));
      const count = sockets.length;
      vi.advanceTimersByTime(wait - 1);
      await flush();
      expect(sockets).toHaveLength(count);
      vi.advanceTimersByTime(1);
      await vi.waitFor(() => expect(sockets).toHaveLength(count + 1));
    }
    connection.stop();
  }),
);

test('heartbeat: a push an HTTP pull confirms while a ping awaits its pong keeps the pong deadline, closing the link when no pong arrives', () =>
  withFakeTimers(async () => {
    // The second token request (the pull after the hint) answers only once the ping is out.
    const pulling = Promise.withResolvers<string>();
    let tokens = 0;
    const token = () => (++tokens === 2 ? pulling.promise : Promise.resolve('valid'));
    const { device, connection, sockets, message, space, executedElsewhere, open, catchUp } = await heartbeat({ token });
    open();
    catchUp();
    await flush();
    await write(device, (tx) => tx.insert(workout).values({ id: 'small' }));
    await flush();
    executedElsewhere();
    message(JSON.stringify({ hint: space.head() }));
    await flush();
    pingsAfterUpload(sockets[0]?.sent ?? [], 0);
    pulling.resolve('valid');
    for (let step = 0; step < 10; step += 1) await flush();
    expect(device.private.pendingCount()).toBe(0);
    vi.advanceTimersByTime(rustLimits().pongWithin - 1);
    expect(sockets[0]?.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sockets[0]?.closed).toBe(true);
    connection.stop();
  }));
