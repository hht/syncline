import { expect, test } from 'vitest';
import { pullNeeded } from '../common/protocol.ts';
import { RecordingSocket } from '../test/test-sockets.ts';
import { setup, subscriptions } from './test-broadcast.ts';

// Connections a broadcast shard closes at once, and how closing connections leave the expiry that schedules its next alarm.

test('a device connecting without a cookie is closed as needing a pull, and a closing connection does not set the next expiry', async () => {
  const { shard, connect } = await setup();
  const at = Date.now() + 60_000;
  const uncookied = new RecordingSocket();
  await shard().accept(uncookied, null, at - 1000, subscriptions.public);
  expect(uncookied.closed).toEqual([pullNeeded]);
  await connect('public', at);
  expect(shard().closeExpired()).toBe(at);
});
