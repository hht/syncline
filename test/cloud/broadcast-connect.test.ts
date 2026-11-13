import { expect, test } from 'vitest';
import { pullNeeded } from '../../src/common/protocol.ts';
import { RecordingSocket } from '../support/test-sockets.ts';
import { last, setup, subscriptions, unsent } from './test-broadcast.ts';

// Connecting to a broadcast shard: connections it closes at once, how closing connections leave the expiry that schedules its next
// alarm, and what one connection's catch-up leaves untouched for the others.

test('a device connecting without a cookie is closed as needing a pull, and a closing connection does not set the next expiry', async () => {
  const { shard, connect } = await setup();
  const at = Date.now() + 60_000;
  const uncookied = new RecordingSocket();
  await shard().accept(uncookied, null, at - 1000, subscriptions.public);
  expect(uncookied.closed).toEqual([pullNeeded]);
  await connect('public', at);
  expect(shard().closeExpired()).toBe(at);
});

test('the answer to a connecting device catches up that connection only: a round still on its way to the shard reaches the devices already connected', async () => {
  const { space, shard, catalog, restart, connect } = await setup();
  const earlier = await connect();
  // After a restart the shard holds no answer to reuse, so it asks the space for this device, at head, connecting before the round arrives
  restart();
  const { round } = unsent(space());
  expect(last(await connect('admin'))).toMatchObject({ cookie: round.cookie, patch: [] });
  await shard().notify(round);
  expect(last(earlier)).toMatchObject({ base: catalog.cookie(), cookie: round.cookie, patch: [{ row: { id: 'p2' } }] });
});
