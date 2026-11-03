import { expect, test } from 'vitest';
import { alarmAfter, object, online, squat } from './test-space.ts';

test('接入方自己的定时：到时候调 scheduled，与导出共用一个 alarm、互不覆盖；撤掉的不调；名字不能以 syncline: 开头', async () => {
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

test('接入方在 scheduled 里给自己排下一次（循环的定时）：做完不被删，下一次照样到', async () => {
  const { name } = await online(1);
  await object(name).remind('recurring', Date.now());
  await alarmAfter(object(name), 0);
  expect(await object(name).fired()).toEqual(['recurring']);
  await alarmAfter(object(name), 7 * 86_400_000);
  expect(await object(name).fired()).toEqual(['recurring', 'recurring']);
});
