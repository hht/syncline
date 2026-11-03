import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, vi } from 'vitest';

/**
 * 等共用空间 name 的扇出送完（全部分片都确认到最新一版、落了库）：对象一启动、每次后台写都向各分片发一轮，分片接不上又回来问最新一版；
 * 测试文件结束前等它们都送完，测试环境拆掉时没有还在路上的调用
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
