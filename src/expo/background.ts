import { Platform } from 'expo';
import { addExpirationListener, BackgroundTaskResult, registerTaskAsync, unregisterTaskAsync } from 'expo-background-task';
import { defineTask } from 'expo-task-manager';
import { report } from '../common/listeners.ts';
import { syncOnce } from './native.ts';
import type { OpenOptions, Schema } from './syncline.ts';

/**
 * 后台同步（可选）：App 不在前台时，系统隔一阵把 App 叫醒，同步一次私有空间（syncOnce：推完待上传、拉到最新）。
 * 什么时候跑由系统定（iOS 的 BGTaskScheduler、Android 的 WorkManager）：最短 15 分钟，iOS 常常几小时一次、多在充电联网时，不保证准时；
 * iOS 要收回时间时随即结束任务、挂起 App，这里的中止不保证来得及执行；每一步都是原子的，停在哪都不留半截，下次接着来。
 * 用法：在 App 一加载就执行的模块顶层调用 defineBackgroundSync（Android 上系统在后台叫醒 App 时只跑 JS、不挂界面，任务要先定义好），登录后 startBackgroundSync、
 * 退出登录 stopBackgroundSync；Expo 配置的 plugins 加上 'expo-background-task'（登记 iOS 的后台模式）。
 * 不该知道的：同步怎么进行。
 * @see https://docs.expo.dev/versions/latest/sdk/background-task/
 * @see https://github.com/expo/expo/blob/expo-background-task%4058.0.11/packages/expo-background-task/ios/BackgroundTaskAppDelegate.swift （到期时发出通知后立即 setTaskCompleted）
 * @see https://docs.expo.dev/versions/latest/sdk/task-manager/ （defineTask 要在模块顶层调用、模块加载时就定义好）
 */

const task = 'syncline-background-sync';

/** 一次后台同步至多多久：iOS 的处理任务能跑几分钟、随时可能被收回，Android 的 WorkManager 一次至多 10 分钟 */
const budget = 3 * 60_000;

/** 定义后台同步要做的事：options 给出要同步的库（同 openSyncline 的选项），没登录就给 undefined，这次什么也不做。在模块顶层调用 */
export function defineBackgroundSync(options: () => OpenOptions<Schema> | undefined | Promise<OpenOptions<Schema> | undefined>) {
  defineTask(task, async () => {
    const opened = await options();
    if (!opened) return BackgroundTaskResult.Success;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('后台同步超时')), budget);
    const expiration = Platform.OS === 'ios' ? addExpirationListener(() => controller.abort(new Error('系统收回了后台时间'))) : undefined;
    try {
      await syncOnce(opened, { signal: controller.signal });
      return BackgroundTaskResult.Success;
    } catch (error) {
      if (!controller.signal.aborted) report(error);
      return BackgroundTaskResult.Failed;
    } finally {
      clearTimeout(timer);
      expiration?.remove();
    }
  });
}

/** 开始后台同步（登录后）：系统至少隔 minimumInterval 分钟（最短 15）才叫醒一次 */
export const startBackgroundSync = (minimumInterval = 15) => registerTaskAsync(task, { minimumInterval });

/** 停止后台同步（退出登录） */
export const stopBackgroundSync = () => unregisterTaskAsync(task);
