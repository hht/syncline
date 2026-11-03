import { expect, test, vi } from 'vitest';
import { flush, withFakeTimers } from '../test/test-drive.ts';
import { heartbeat, pullsBeforeReconnect, receiveTimesOut } from './test-connection.ts';

// Heartbeat: pings when idle, treats timeout without response as disconnect; pulls via HTTP before reconnect on catch-up timeout.

test('heartbeat: pings after 25s idle, resets timer on incoming message; disconnects and reconnects after 30s without reply', () =>
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
    // Disconnected after receiving messages: standard reconnect without preceding HTTP pull.
    expect(fetched).toEqual([]);
  }));

test('heartbeat: stops sending pings after stop or connection close', () =>
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

test('falls back to HTTP pull before reconnecting when catch-up times out after connection open', () =>
  withFakeTimers(async () => {
    const harness = await heartbeat();
    const { connection, fetched, open } = harness;
    open();
    receiveTimesOut(harness);
    expect(fetched).toEqual([]);
    await pullsBeforeReconnect(harness);
    connection.stop();
  }));

test('reconnects normally without HTTP pull when handshake times out before completion', () =>
  withFakeTimers(async () => {
    const harness = await heartbeat();
    const { connection, sockets, fetched } = harness;
    receiveTimesOut(harness);
    vi.runOnlyPendingTimers();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(fetched).toEqual([]);
    connection.stop();
  }));
