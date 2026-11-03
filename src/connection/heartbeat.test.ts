import { expect, test, vi } from 'vitest';
import { flush, withFakeTimers } from '../test/test-drive.ts';
import { heartbeat, pullsBeforeReconnect, receiveTimesOut } from './test-connection.ts';

// 心跳：空闲发 ping、等不到回音就当断了；连上了却等不到补齐的，下次先 HTTP 拉取再连

test('心跳：空闲 25 秒发 ping，收到任何消息都重新计时；发出后 30 秒没有回音（够最慢的网传完一条消息）就当连接已断，不等关闭握手，立即重连', () =>
  withFakeTimers(async () => {
    const { sockets, fetched, open, message } = await heartbeat();
    open();
    vi.advanceTimersByTime(20_000);
    message('pong');
    vi.advanceTimersByTime(24_999);
    expect(sockets[0]?.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sockets[0]?.sent).toEqual(['ping']);

    vi.advanceTimersByTime(5_000);
    message('pong');
    vi.advanceTimersByTime(24_999);
    expect(sockets[0]?.sent).toEqual(['ping']);
    vi.advanceTimersByTime(1);
    expect(sockets[0]?.sent).toEqual(['ping', 'ping']);

    vi.advanceTimersByTime(29_999);
    expect(sockets[0]?.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sockets[0]?.closed).toBe(true);
    vi.runOnlyPendingTimers();
    await flush();
    expect(sockets).toHaveLength(2);
    // 收到过消息才断的：照常重连，不先 HTTP 拉取
    expect(fetched).toEqual([]);
  }));

test('心跳：stop 之后、连接关了之后都不再发 ping', () =>
  withFakeTimers(async () => {
    const stopped = await heartbeat();
    stopped.open();
    stopped.connection.stop();
    vi.advanceTimersByTime(60_000);
    expect(stopped.sockets[0]?.sent).toEqual([]);

    const closed = await heartbeat();
    closed.open();
    closed.sockets[0]?.socket.onclose?.(new CloseEvent('close', { code: 1006 }));
    vi.advanceTimersByTime(60_000);
    expect(closed.sockets[0]?.sent).toEqual([]);
    closed.connection.stop();
  }));

test('连上之后等补齐超时（慢网上一条补齐传不完）：下次先 HTTP 拉取再连', () =>
  withFakeTimers(async () => {
    const harness = await heartbeat();
    const { connection, fetched, open } = harness;
    open();
    receiveTimesOut(harness);
    expect(fetched).toEqual([]);
    await pullsBeforeReconnect(harness);
    connection.stop();
  }));

test('握手一直没完成就超时：照常重连，不先 HTTP 拉取（补齐没等到才先拉）', () =>
  withFakeTimers(async () => {
    const harness = await heartbeat();
    const { connection, sockets, fetched } = harness;
    receiveTimesOut(harness);
    vi.runOnlyPendingTimers();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(fetched).toEqual([]);
    connection.stop();
  }));
