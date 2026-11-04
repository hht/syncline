import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { lease } from './schedule.ts';
import { alarmAfter, object, online, squat } from './test-space.ts';

test('executes scheduled callback when due, multiplexes with exports, skips cancelled tasks, and rejects syncline: prefix', async () => {
  const { name, phone } = await online(1);
  const hour = 3_600_000;
  await object(name).remind('weekly', Date.now() + hour);
  await object(name).remind('dropped', Date.now() + hour);
  await object(name).forget('dropped');
  await expect(() => object(name).remind('syncline:export:stats', Date.now())).rejects.toThrow('syncline:');
  phone.push(squat);
  await phone.next();
  expect(Number(await object(name).alarmAt()) - Date.now()).toBeLessThanOrEqual(60_000);
  await alarmAfter(object(name), 60_000);
  expect(await object(name).exported()).toHaveLength(1);
  expect(await object(name).fired()).toEqual([]);
  expect(Number(await object(name).alarmAt()) - Date.now()).toBeGreaterThan(hour - 120_000);
  await alarmAfter(object(name), hour);
  expect(await object(name).fired()).toEqual(['weekly']);
  expect(await object(name).alarmAt()).toBeNull();
});

test('supports recurring tasks that reschedule themselves in scheduled callbacks', async () => {
  const { name } = await online(1);
  await object(name).remind('recurring', Date.now());
  await alarmAfter(object(name), 0);
  expect(await object(name).fired()).toEqual(['recurring']);
  await alarmAfter(object(name), 7 * 86_400_000);
  expect(await object(name).fired()).toEqual(['recurring', 'recurring']);
});

test('an actor reset during a chore keeps it scheduled: once the lease expires, the alarm runs it to completion', async () => {
  const { name, phone } = await online(1);
  await object(name).hangExports(true);
  phone.push(squat);
  await phone.next();
  const running = alarmAfter(object(name), 60_000).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await runInDurableObject(object(name), (_, state) => state.abort('Reset')).catch(() => undefined);
  await running;
  await object(name).hangExports(false);
  expect(await object(name).alarmAt()).not.toBeNull();
  await alarmAfter(object(name), lease);
  expect(await object(name).exported()).toHaveLength(1);
});
