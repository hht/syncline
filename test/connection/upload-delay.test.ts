import { expect, test, vi } from 'vitest';
import { flush, withFakeTimers } from '../support/test-drive.ts';
import { workbook, write } from '../support/test-schema.ts';
import { heartbeat, linked } from './test-connection.ts';

// Upload delay: a local write opens a fixed window, later writes do not extend it, and pushes stop before the window's first write until
// it closes, so writes made meanwhile upload together; sync(), resync(), and stop close the window.

const delay = 5000;

/** Ids of the workbooks in each batch sent on the latest socket. */
const batches = (sockets: { sent: string[] }[]) =>
  (sockets.at(-1)?.sent ?? [])
    .filter((text) => text.startsWith('['))
    .map((text) =>
      (JSON.parse(text) as { changes: { row: { id: string } }[] }[]).flatMap(({ changes }) => changes.map(({ row }) => row.id)),
    );

const add = (device: Awaited<ReturnType<typeof heartbeat>>['device'], id: string) =>
  write(device, (tx) => tx.insert(workbook).values({ id, note: id }));

test('writes made within the window upload together when it closes, the window not extended by later writes', () =>
  withFakeTimers(async () => {
    const { device, connection, sockets } = await linked({ uploadDelay: delay });
    await add(device, 'w1');
    vi.advanceTimersByTime(delay - 1000);
    await add(device, 'w2');
    await flush();
    expect(batches(sockets)).toEqual([]);
    vi.advanceTimersByTime(1000);
    await flush();
    expect(batches(sockets)).toEqual([['w1', 'w2']]);
    connection.stop();
  }));

test('writes from before the window upload at once while writes in it wait, also after the earlier batch confirms', () =>
  withFakeTimers(async () => {
    const { device, connection, sockets, open, catchUp, confirm } = await heartbeat({ uploadDelay: delay });
    connection.stop();
    await add(device, 'w1');
    connection.start();
    await flush();
    open();
    catchUp();
    await flush();
    await add(device, 'w2');
    await flush();
    expect(batches(sockets)).toEqual([['w1']]);
    confirm(0);
    await flush();
    expect(batches(sockets)).toEqual([['w1']]);
    vi.advanceTimersByTime(delay);
    await flush();
    expect(batches(sockets)).toEqual([['w1'], ['w2']]);
    connection.stop();
  }));

test('sync() closes the window, and writes made while it waits open none', () =>
  withFakeTimers(async () => {
    const { device, connection, sockets, confirm } = await linked({ uploadDelay: delay });
    await add(device, 'w1');
    const synced = connection.sync();
    await flush();
    expect(batches(sockets)).toEqual([['w1']]);
    await add(device, 'w2');
    confirm(0);
    await flush();
    expect(batches(sockets)).toEqual([['w1'], ['w2']]);
    confirm(1);
    await synced;
    connection.stop();
  }));

/** Opens the latest socket and catches up: the write w1, left pending, uploads at once. */
async function uploadsOnOpen({ connection, sockets, open, catchUp }: Awaited<ReturnType<typeof heartbeat>>) {
  open();
  catchUp();
  await flush();
  expect(batches(sockets)).toEqual([['w1']]);
  connection.stop();
}

test('stopping closes the window: after restarting, the write uploads once the socket opens', () =>
  withFakeTimers(async () => {
    const harness = await linked({ uploadDelay: delay });
    await add(harness.device, 'w1');
    harness.connection.stop();
    harness.connection.start();
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(2));
    await uploadsOnOpen(harness);
  }));

test('resync() closes the window: once the download lands, the write uploads as the new socket opens', () =>
  withFakeTimers(async () => {
    const harness = await linked({ uploadDelay: delay });
    await add(harness.device, 'w1');
    const resynced = harness.connection.resync();
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(2));
    await uploadsOnOpen(harness);
    await expect(resynced).rejects.toThrow('sync has stopped');
  }));

test('a window that closes while offline lets the next connection upload its writes at once', () =>
  withFakeTimers(async () => {
    const harness = await heartbeat({ uploadDelay: delay });
    await add(harness.device, 'w1');
    vi.advanceTimersByTime(delay);
    await flush();
    await uploadsOnOpen(harness);
  }));
