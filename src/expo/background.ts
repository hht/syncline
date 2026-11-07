import { Platform } from 'expo';
import { addExpirationListener, BackgroundTaskResult, registerTaskAsync, unregisterTaskAsync } from 'expo-background-task';
import { defineTask } from 'expo-task-manager';
import { report } from '../common/listeners.ts';
import { syncOnce } from './native.ts';
import type { OpenOptions, Schema } from './syncline.ts';

/**
 * Runs background synchronization when the app is not in the foreground.
 *
 * The operating system wakes the app periodically to sync the private space once via `syncOnce` (pushing pending writes and pulling to
 * head). Schedule timing is determined by the system (BGTaskScheduler on iOS, WorkManager on Android): minimum 15 minutes, often every few
 * hours on iOS while charging and connected to network, without timing guarantees. When iOS reclaims background time it terminates the
 * task immediately and suspends the app; aborting here cannot be guaranteed to complete before suspension. Each step is atomic so
 * interruption leaves no partial state and sync resumes on the next wake.
 *
 * Usage: Call `defineBackgroundSync` at the top level of a module loaded on app startup (Android runs JS without mounting UI when waking
 * in the background, so the task must already be registered), call `startBackgroundSync` after sign-in, and call `stopBackgroundSync` on
 * sign-out. Add `'expo-background-task'` to the Expo configuration plugins to register the iOS background mode.
 * What this module must not know: How sync proceeds internally.
 * @see https://docs.expo.dev/versions/latest/sdk/background-task/
 * @see https://github.com/expo/expo/blob/expo-background-task%4058.0.11/packages/expo-background-task/ios/BackgroundTaskAppDelegate.swift
 * @see https://docs.expo.dev/versions/latest/sdk/task-manager/
 */

const task = 'syncline-background-sync';

/**
 * Maximum duration for a single background sync pass: iOS tasks run for a few minutes before revocation, Android WorkManager allows
 * up to 10 minutes.
 */
const budget = 3 * 60_000;

/**
 * Defines background sync work. The `options` callback provides the database configuration (same as `openSyncline`); returns undefined
 * when signed out to skip the run. Must be called at the top level of a module.
 */
export function defineBackgroundSync(options: () => OpenOptions<Schema> | undefined | Promise<OpenOptions<Schema> | undefined>) {
  defineTask(task, async () => {
    const opened = await options();
    if (!opened) return BackgroundTaskResult.Success;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Background sync timed out')), budget);
    const expiration =
      Platform.OS === 'ios'
        ? addExpirationListener(() => controller.abort(new Error('Operating system reclaimed background time')))
        : undefined;
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

/** Starts background sync after sign-in. The system wakes the app no more often than every `minimumInterval` minutes (minimum 15). */
export const startBackgroundSync = ({ minimumInterval = 15 }: { minimumInterval?: number } = {}) =>
  registerTaskAsync(task, { minimumInterval });

/** Stops background sync on sign-out. */
export const stopBackgroundSync = () => unregisterTaskAsync(task);
