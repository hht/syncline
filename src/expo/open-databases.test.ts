import { expect, test } from 'vitest';
import { OpenDatabases } from './open-databases.ts';

// 一个进程里一个本机库只开一份：前台打开与后台任务的 syncOnce 怎么共用

/** 假的一份库：记下同步与关掉了几次；sync 等 finish 才结束 */
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

/** 后台任务的 syncOnce 正开着 u1 的库时，前台打开同一个人的 */
function adopted() {
  const databases = new OpenDatabases<Fake>();
  const background = fake(databases, 'app');
  const once = databases.syncOnce('app', 'u1', () => background);
  const foreground = databases.open('app', 'u1', () => fake(databases, 'app'));
  return { databases, background, once, foreground };
}

test('后台任务的 syncOnce 开着库时用户点开 App（同一个人）：前台接管开着的那份，不抛错；syncOnce 同步完不关它', async () => {
  const { databases, background, once, foreground } = adopted();
  expect(foreground).toBe(background);
  background.finish();
  await once;
  expect(background.closed).toBe(0);
  // 前台照常用它：再打开一次是重复打开
  expect(() => databases.open('app', 'u1', () => fake(databases, 'app'))).toThrow('已经开着');
});

test('后台开着的是别人的库（换了人登录）：前台不接管，先关掉后台那份再开自己的，不抛错；syncOnce 同步完不再关第二次', async () => {
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
  expect(() => databases.open('app', 'u2', () => fake(databases, 'app'))).toThrow('已经开着');
});

test('前台开着时后台任务的 syncOnce 用开着的那份、不关；没开着就开一份，同步完关掉', async () => {
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

test('前台接管之后又关掉了（退出登录），syncOnce 同步完不再关第二次', async () => {
  const { background, once, foreground } = adopted();
  await foreground.close();
  background.finish();
  await once;
  expect(background.closed).toBe(1);
});

test('同步出错时 syncOnce 开的那份照样关掉，错误抛给调用方', async () => {
  const databases = new OpenDatabases<Fake>();
  const space = fake(databases, 'app');
  space.sync = () => Promise.reject(new Error('断网'));
  await expect(databases.syncOnce('app', 'u1', () => space)).rejects.toThrow('断网');
  expect(space.closed).toBe(1);
});
