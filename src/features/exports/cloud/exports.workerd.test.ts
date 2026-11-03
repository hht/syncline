import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { alarmAfter, object, online, put, squat } from '../../../cloudflare/test-space.ts';
import type { TestSpace } from '../../../cloudflare/test-worker.ts';
import { defaultExportDelay, maxExportDelay } from './exports.ts';

// 导出（跨 DO 汇总统计等）接到 alarm 上：写了之后排一次，导出者分开导、出错按退避自己重排，云端的历史换掉（时间点恢复）之后从头整份

/** 设备 c1 第 1 条写之后第一次导出收到的：整份，先清空 */
const firstExport = {
  reset: false,
  patch: [{ op: 'clear' }, { op: 'put', table: 'note', key: { id: 'n1' }, row: { id: 'n1', text: '深蹲' } }],
};

/** 跑 alarm：导出者收到第一条写的整份，之后没有新写就不再排 */
async function exportedOnce(name: string) {
  expect(await alarmAfter(object(name), maxExportDelay)).toBe(true);
  expect(await object(name).exported()).toEqual([firstExport]);
  expect(await alarmAfter(object(name), maxExportDelay)).toBe(false);
}

test('导出：写了之后排一次 alarm，alarm 里导出者收到整份（先清空）与之后改过的行；没有新写时 alarm 不再排', async () => {
  const { name, phone: device } = await online(1);
  device.push(squat);
  await device.next();
  await exportedOnce(name);
});

test('导出过之后云端的历史换掉了（时间点恢复）：下一次写排的 alarm 里，导出者收到标 reset 的整份（先清空），统计不留被回滚的数据', async () => {
  const { name, phone: device } = await online(1);
  device.push(squat);
  await device.next();
  await alarmAfter(object(name), defaultExportDelay);
  // 本机的存储不支持时间点恢复：把导出过的那一版的随机数改掉，当作恢复后又写到了同一版
  await runInDurableObject(object(name), (_: TestSpace, state) => {
    state.storage.sql.exec('UPDATE _syncline_commit SET nonce = nonce + 1');
  });
  await object(name).importNotes([{ id: 'n2', text: '硬拉' }]);
  expect(await alarmAfter(object(name), defaultExportDelay)).toBe(true);
  expect(await object(name).exported()).toEqual([
    firstExport,
    {
      reset: true,
      patch: [
        { op: 'clear' },
        { op: 'put', table: 'note', key: { id: 'n1' }, row: { id: 'n1', text: '深蹲' } },
        { op: 'put', table: 'note', key: { id: 'n2' }, row: { id: 'n2', text: '硬拉' } },
      ],
    },
  ]);
});

/** 一台设备写了第一条，stats 导出者一直出错 */
async function withFailingStats() {
  const { name, phone: device } = await online(1);
  await object(name).failExports(true);
  device.push(squat);
  await device.next();
  return { name, device };
}

/** 导出者最后收到的一块 */
const lastOf = async (chunks: Promise<unknown[]>) => ((await chunks) as unknown[]).at(-1);

test('导出者出错：不挡别的导出者；接住后按退避自己排下一次 alarm，平台的 6 次重试用完也照样重试，好了之后导完、不再排', async () => {
  const { name } = await withFailingStats();
  for (let attempt = 0; attempt < 8; attempt += 1) expect(await alarmAfter(object(name), maxExportDelay)).toBe(true);
  expect(await object(name).exported()).toEqual([]);
  expect(await object(name).searched()).toHaveLength(1);
  await object(name).failExports(false);
  await exportedOnce(name);
});

test('一个导出者一直出错：只推后它自己，别的导出者有了新写照常在 exportDelay 之后导，不被它的退避拖到一小时一次', async () => {
  const { name, device } = await withFailingStats();
  for (let attempt = 0; attempt < 6; attempt += 1) await alarmAfter(object(name), maxExportDelay);
  device.push({ id: 2, changes: [put('note', { id: 'n2', text: '卧推' })] });
  await device.next();
  const at = await object(name).alarmAt();
  expect(at).not.toBeNull();
  expect(Number(at) - Date.now()).toBeLessThanOrEqual(defaultExportDelay);
  // 出错的那个还在退避中：新写不把它提前
  const stats = await runInDurableObject(object(name), (_: TestSpace, state) =>
    state.storage.sql.exec("SELECT at FROM _syncline_schedule WHERE name = 'syncline:export:stats'").one(),
  );
  expect(Number(stats.at) - Date.now()).toBeGreaterThan(2 * defaultExportDelay);
  await alarmAfter(object(name), defaultExportDelay);
  expect(await lastOf(object(name).searched())).toMatchObject({ patch: [{ op: 'put', row: { id: 'n2' } }] });
});

test('接入方自己删掉了 alarm：下一次写照常排上导出，不会因为记着「排着」就再也不导', async () => {
  const { name, phone: device } = await online(1);
  device.push(squat);
  await device.next();
  await object(name).clearAlarm();
  device.push({ id: 2, changes: [put('note', { id: 'n2', text: '卧推' })] });
  await device.next();
  expect(await object(name).alarmAt()).not.toBeNull();
  expect(await alarmAfter(object(name), defaultExportDelay)).toBe(true);
  expect(await lastOf(object(name).exported())).toMatchObject({
    patch: expect.arrayContaining([{ op: 'put', table: 'note', key: { id: 'n2' }, row: { id: 'n2', text: '卧推' } }]),
  });
});

test('一个导出者一直不回话（去处卡住）：到了这次的时间预算就算这次失败、按退避重排，alarm 照常结束，别的导出者照常导', async () => {
  const { name, phone: device } = await online(1);
  await object(name).hangExports(true);
  device.push(squat);
  await device.next();
  // 测试 Worker 的时间预算是 1 秒
  expect(await alarmAfter(object(name), defaultExportDelay)).toBe(true);
  expect(await object(name).searched()).toHaveLength(1);
  expect(await object(name).alarmAt()).not.toBeNull();
  await object(name).hangExports(false);
  await exportedOnce(name);
});
