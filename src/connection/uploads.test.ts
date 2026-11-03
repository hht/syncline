import { expect, test, vi } from 'vitest';
import { slowestRate, socketLimit } from '../common/protocol.ts';
import { flush, withFakeTimers } from '../test/test-drive.ts';
import { workout, write } from '../test/test-schema.ts';
import { heartbeat, pingsAfterUpload, pingsIn, pullsBeforeReconnect, receiveTimesOut, reconnect } from './test-connection.ts';

// 上传与心跳：推送一批按字节封顶；发出一批之后按最慢的网传完它之前不发 ping（几批按发出的先后排），收到这条连接上推的那批的确认就不再等

test('心跳：发出一大批推送之后，按最慢的网传完它之前不发 ping（ping 排在它后面），其间收到消息也不发；传完了再空闲 25 秒发', () =>
  withFakeTimers(async () => {
    const { connection, sockets, message, pushBig } = await heartbeat();
    await pushBig();
    const bytes = new TextEncoder().encode(sockets[0]?.sent[0]).length;
    expect(sockets[0]?.sent).toHaveLength(1);
    // 按每秒 1 KB 约 300 秒传完：中途收到一条消息也不发 ping、不判断线
    const done = (bytes / slowestRate) * 1000;
    vi.advanceTimersByTime(done - 10_000);
    message('pong');
    vi.advanceTimersByTime(10_000 - 1);
    expect(sockets[0]?.sent).toHaveLength(1);
    expect(sockets[0]?.closed).toBe(false);
    pingsIn(sockets[0]?.sent ?? [], 25_001);
    connection.stop();
  }));

test('推送一批按 UTF-8 字节封顶在 WebSocket 一条消息上限的一半：每条约 8 千字节的 3 条写，第一批推 2 条', async () => {
  const { device, connection, sockets, open } = await heartbeat();
  const third = '深'.repeat(Math.ceil(socketLimit / 9));
  for (const id of ['n1', 'n2', 'n3']) await write(device, (tx) => tx.insert(workout).values({ id, note: third }));
  // 连接打开时一次推出去：攒下的 3 条按上限分批
  open();
  await flush();
  expect(sockets[0]?.sent).toHaveLength(1);
  expect(JSON.parse(sockets[0]?.sent[0] ?? '[]')).toHaveLength(2);
  connection.stop();
});

test('心跳：离线攒下的一大批在连上时推出去，同样按它传完之前不发 ping', () =>
  withFakeTimers(async () => {
    const { device, connection, sockets, open, catchUp } = await heartbeat();
    await write(device, (tx) => tx.insert(workout).values({ id: 'big', note: '深'.repeat(100_000) }));
    open();
    catchUp();
    await flush();
    pingsAfterUpload(sockets[0]?.sent ?? [], 0);
    connection.stop();
  }));

test('心跳：前一批确认了、推下一批时，按下一批重新算不发 ping 的时间（前一批的不再作数）', () =>
  withFakeTimers(async () => {
    const { device, connection, sockets, open, catchUp, confirm } = await heartbeat();
    // 两条大写各成一批：第一批约 3 万字节（约 30 秒），第二批约 30 万字节（约 300 秒）
    await write(device, (tx) => tx.insert(workout).values({ id: 'mid', note: '深'.repeat(10_000) }));
    await write(device, (tx) => tx.insert(workout).values({ id: 'big', note: '浅'.repeat(100_000) }));
    open();
    catchUp();
    await flush();
    confirm(0);
    await flush();
    expect(sockets[0]?.sent).toHaveLength(2);
    pingsAfterUpload(sockets[0]?.sent ?? [], 1);
    connection.stop();
  }));

test('心跳：连上时推出一小批、补齐还没到，这批的估算到期也不停掉等补齐的计时：补齐等不到，下次照样先 HTTP 拉取', () =>
  withFakeTimers(async () => {
    const harness = await heartbeat();
    const { device, connection, sockets, open } = harness;
    // 约 5 千字节，估算约 5 秒传完
    await write(device, (tx) => tx.insert(workout).values({ id: 'big', note: '深'.repeat(1700) }));
    open();
    await flush();
    expect(sockets[0]?.sent).toHaveLength(1);
    receiveTimesOut(harness);
    await pullsBeforeReconnect(harness);
    connection.stop();
  }));

test('心跳：一大批推送被确认了（已经传完），不再等估算到期，从确认起空闲 25 秒发 ping', () =>
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

test('心跳：重连后重推的一大批，补齐里就带着它的确认（旧连接上已执行）：这条连接上重推的还在传，照样等估算；接着推的一小批排在它后面', () =>
  withFakeTimers(async () => {
    const { device, connection, sockets, open, catchUp, executedElsewhere } = await heartbeat();
    await write(device, (tx) => tx.insert(workout).values({ id: 'big', note: '深'.repeat(100_000) }));
    executedElsewhere();
    open();
    await write(device, (tx) => tx.insert(workout).values({ id: 'small' }));
    catchUp();
    await flush();
    // 补齐确认了重推的那批（旧连接上执行过），于是推了下一小批：两批按先后传完之前都不发 ping
    expect(sockets[0]?.sent).toHaveLength(2);
    const [big = '', small = ''] = sockets[0]?.sent ?? [];
    const bytes = new TextEncoder().encode(big).length + new TextEncoder().encode(small).length;
    pingsIn(sockets[0]?.sent ?? [], (bytes / slowestRate) * 1000 + 25_000);
    connection.stop();
  }));

test('心跳：旧连接上的一大批晚到云端、在新连接补齐之后才执行，它的确认到了新连接上：新连接上重推的还在传，照样等估算', () =>
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

test('心跳：清空重下换了客户端、换了连接之后推的一批，被确认了就是这条连接上推的传完了（旧连接上那批是别的客户端的，不算重推）', () =>
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

test('推送每次都处理不了（1011）：退避照常加长，不因连上收到补齐就从头算（不然约每秒重推一次）', () =>
  withFakeTimers(async () => {
    // 抖动取上限：第 n 次失败后等 1 秒 × 2^n
    const { device, connection, sockets, open, catchUp } = await heartbeat({ random: () => 1 });
    await write(device, (tx) => tx.insert(workout).values({ id: 'w1' }));
    for (const wait of [1000, 2000, 4000]) {
      open();
      catchUp();
      await flush();
      sockets.at(-1)?.socket.onclose?.(new CloseEvent('close', { code: 1011 }));
      const count = sockets.length;
      vi.advanceTimersByTime(wait - 1);
      await flush();
      expect(sockets).toHaveLength(count);
      vi.advanceTimersByTime(1);
      await vi.waitFor(() => expect(sockets).toHaveLength(count + 1));
    }
    connection.stop();
  }));
