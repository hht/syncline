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

/** Sets up a background syncOnce task active for owner u1 when foreground opens the same owner. */
function adopted() {
  const databases = new OpenDatabases<Fake>();
  const background = fake(databases, 'app');
  const once = databases.syncOnce('app', 'u1', () => background);
  const foreground = databases.open('app', 'u1', () => fake(databases, 'app'));
  return { databases, background, once, foreground };
}

test('foreground adopts background instance for same owner when user opens app; syncOnce completes without closing it', async () => {
  const { databases, background, once, foreground } = adopted();
  expect(foreground).toBe(background);
  background.finish();
  await once;
  expect(background.closed).toBe(0);
  // Foreground continues using adopted instance: opening again throws already open.
  expect(() => databases.open('app', 'u1', () => fake(databases, 'app'))).toThrow('already open');
});

test('foreground closes background instance of different owner before opening its own; syncOnce does not close twice', async () => {
  const databases = new OpenDatabases<Fake>();
  const background = fake(databases, 'app');
  const once = databases.syncOnce('app', 'u1', () => background);
  const foreground = databases.open('app', 'u2', () => fake(databases, 'app'));
  expect(foreground).not.toBe(background);
  expect(background.closed).toBe(1);
  background.finish();
  await once;
  expect(background.closed).toBe(1);
  expect(foreground.closed).toBe(0);
  expect(() => databases.open('app', 'u2', () => fake(databases, 'app'))).toThrow('already open');
});

test('syncOnce reuses open foreground instance without closing it; opens and closes instance if not already open', async () => {
  const databases = new OpenDatabases<Fake>();
  const foreground = databases.open('app', 'u1', () => fake(databases, 'app'));
  const once = databases.syncOnce('app', 'u1', () => fake(databases, 'app'));
  expect(foreground.synced).toBe(1);
  foreground.finish();
  await once;
  expect(foreground.closed).toBe(0);

  const other = fake(databases, 'other');
  const alone = databases.syncOnce('other', 'u1', () => other);
  other.finish();
  await alone;
  expect(other.closed).toBe(1);
});

test('closing adopted instance on sign-out does not cause syncOnce to close a second time on completion', async () => {
  const { background, once, foreground } = adopted();
  await foreground.close();
  background.finish();
  await once;
  expect(background.closed).toBe(1);
});

test('syncOnce closes opened instance when sync fails and propagates error to caller', async () => {
  const databases = new OpenDatabases<Fake>();
  const space = fake(databases, 'app');
  space.sync = () => Promise.reject(new Error('Network disconnected'));
  await expect(databases.syncOnce('app', 'u1', () => space)).rejects.toThrow('Network disconnected');
  expect(space.closed).toBe(1);
});
