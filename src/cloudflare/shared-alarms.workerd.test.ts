import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, expect, test } from 'vitest';
import { fannedOut } from './test-shared.ts';
import { alarmAfter } from './test-space.ts';

// Shared space schedule left alone: a server write changing no rows schedules no delivery, and a reserved chore an earlier deploy left is dropped.

afterAll(() => fannedOut('quiet'));

const quiet = () => env.CATALOG.getByName('quiet');

test('a server write changing no rows commits no version and leaves the hourly wakeup in place', async () => {
  await quiet().publish('z1');
  await fannedOut('quiet');
  const state = () =>
    runInDurableObject(quiet(), (_, { storage }) => ({
      head: storage.sql.exec('SELECT max(version) AS version FROM _syncline_commit').one().version,
      deliverIn: Number(storage.sql.exec("SELECT at FROM _syncline_schedule WHERE name = 'syncline:deliver'").one().at) - Date.now(),
    }));
  const { head } = await state();
  await quiet().withdraw('missing');
  // A delivery would be due within a second; the hourly wakeup stays about an hour away
  expect(await state()).toEqual({ head, deliverIn: expect.toSatisfy((ms: number) => ms > 3_500_000) });
});

test('a reserved chore this version no longer knows (left by an earlier deploy) is dropped when due without running anything', async () => {
  await runInDurableObject(quiet(), (_, state) => {
    state.storage.sql.exec("INSERT INTO _syncline_schedule (name, at, failures) VALUES ('syncline:retired', 0, 0)");
  });
  await alarmAfter(quiet(), 0);
  const left = await runInDurableObject(quiet(), (_, state) =>
    state.storage.sql.exec("SELECT name FROM _syncline_schedule WHERE name = 'syncline:retired'").toArray(),
  );
  expect(left).toEqual([]);
});
