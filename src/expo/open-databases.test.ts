import { expect, test } from 'vitest';
import { OpenDatabases } from './open-databases.ts';

// Verifies single open instance coordination between foreground and background syncOnce tasks.

/** Mock database instance tracking sync and close counts; sync awaits finish before resolving. */
type Fake = { synced: number; closed: number; sync(): Promise<void>; close(): Promise<void>; finish(): void };

function fake(databases: OpenDatabases<Fake>, name: string): Fake {
  let finish: () => void = () => undefined;
  const space: Fake = {
    synced: 0,
    closed: 0,
    sync: () => {
      space.synced += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    close: async () => {
      space.closed += 1;
      databases.closed(name, space);
    },
    finish: () => finish(),
  };
  return space;
}

test('foreground opening during syncOnce closes the background instance and opens its own, so its options take effect; syncOnce resolves without closing again', async () => {
  const databases = new OpenDatabases<Fake>();
  const background = fake(databases, 'app');
  background.sync = () => Promise.reject(new Error('Database closed'));
  const once = databases.syncOnce('app', () => background);
  const foreground = databases.open('app', () => fake(databases, 'app'));
  expect(foreground).not.toBe(background);
  expect(background.closed).toBe(1);
  await once;
  expect([background.closed, foreground.closed]).toEqual([1, 0]);
  expect(() => databases.open('app', () => fake(databases, 'app'))).toThrow('already open');
});

test('syncOnce reuses open foreground instance without closing it; opens and closes instance if not already open', async () => {
  const databases = new OpenDatabases<Fake>();
  const foreground = databases.open('app', () => fake(databases, 'app'));
  const once = databases.syncOnce('app', () => fake(databases, 'app'));
  expect(foreground.synced).toBe(1);
  foreground.finish();
  await once;
  expect(foreground.closed).toBe(0);

  const other = fake(databases, 'other');
  const alone = databases.syncOnce('other', () => other);
  other.finish();
  await alone;
  expect(other.closed).toBe(1);
});

test('syncOnce closes opened instance when sync fails and propagates error to caller', async () => {
  const databases = new OpenDatabases<Fake>();
  const space = fake(databases, 'app');
  space.sync = () => Promise.reject(new Error('Network disconnected'));
  await expect(databases.syncOnce('app', () => space)).rejects.toThrow('Network disconnected');
  expect(space.closed).toBe(1);
});

test('syncOnce reports an open failure even though the failed instance closed itself before sync rejected', async () => {
  const databases = new OpenDatabases<Fake>();
  const space = fake(databases, 'app');
  space.sync = async () => {
    // A database that could not open closes itself before its pending calls reject.
    await space.close();
    throw new Error('PendingWrites');
  };
  await expect(databases.syncOnce('app', () => space)).rejects.toThrow('PendingWrites');
});

test('a second syncOnce sharing the background instance resolves when the foreground supersedes it', async () => {
  const databases = new OpenDatabases<Fake>();
  const background = fake(databases, 'app');
  background.sync = () => new Promise((_, reject) => setTimeout(() => reject(new Error('Database closed')), 0));
  const first = databases.syncOnce('app', () => background);
  const second = databases.syncOnce('app', () => fake(databases, 'app'));
  databases.open('app', () => fake(databases, 'app'));
  await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
});
