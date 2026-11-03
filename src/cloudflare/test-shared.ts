import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, vi } from 'vitest';

/**
 * Waits for fanout delivery to complete on shared space name (all broadcast shards confirmed head version and persisted):
 * on startup and after every server write, rounds are dispatched to shards; tests await full delivery before teardown.
 */
export const fannedOut = (name: string) =>
  vi.waitFor(
    () =>
      runInDurableObject(env.CATALOG.getByName(name), (_, state) => {
        const confirmed = state.storage.kv.get('syncline:fanout');
        const head = state.storage.sql.exec<{ version: number }>('SELECT max(version) AS version FROM _syncline_commit').one();
        expect(confirmed).toMatchObject({ version: head.version });
      }),
    { timeout: 10_000 },
  );
