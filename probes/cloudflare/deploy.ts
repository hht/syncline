import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Disposable Worker for probes, deployed under the active wrangler account using an ephemeral name
 * and a random SECRET generated at deployment time to prevent unauthorized access during execution.
 * Deleted after probing completes, or upon error, SIGINT, or terminal exit. Out of scope: what is probed or how.
 */

const here = import.meta.dirname;
// Runs the bundled wrangler binary directly because tail processes spawned through npx cannot terminate child processes cleanly, hanging the script.
export const wranglerBin = join(here, '../../node_modules/.bin/wrangler');
export const wrangler = (...args: string[]) => execFileSync(wranglerBin, args, { cwd: here, encoding: 'utf8' });

/** Deployed Worker handle, with onCleanUp registering teardown steps such as stopping wrangler tail before Worker deletion. */
type Deployed = { name: string; secret: string; url: string; onCleanUp: (stop: () => void) => void };

/** Deploys a Worker from a wrangler configuration in this directory for measure, deleting it when finished. */
export async function withWorker(config: string, measure: (worker: Deployed) => Promise<void>) {
  const name = `syncline-probe-${randomUUID().slice(0, 8)}`;
  const secret = randomUUID();
  const stops: (() => void)[] = [];
  let cleaned = false;
  // Attempts deletion even if deployment failed, ignoring errors, and runs at most once to prevent duplicate runs on repeated interrupts.
  const cleanUp = () => {
    if (cleaned) return;
    cleaned = true;
    for (const stop of stops) stop();
    try {
      wrangler('delete', '--name', name, '--force');
    } catch (error) {
      console.error(`Failed to delete Worker ${name}, delete manually in the Cloudflare dashboard: ${error}`);
    }
    rmSync(join(here, '.wrangler'), { recursive: true, force: true });
  };
  // Node exits immediately on SIGINT/SIGTERM/SIGHUP without executing finally blocks by default.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(signal, () => {
      cleanUp();
      process.exit(130);
    });
  try {
    const deployed = wrangler('deploy', '--config', config, '--name', name, '--var', `SECRET:${secret}`);
    const url = /https:\/\/\S+\.workers\.dev/.exec(deployed)?.[0];
    if (!url) throw new Error(`Deployment output missing worker URL:\n${deployed}`);
    await measure({ name, secret, url, onCleanUp: (stop) => stops.push(stop) });
  } finally {
    cleanUp();
  }
}

/** Polls a newly deployed Worker until it returns JSON (up to 60 seconds), absorbing initial platform errors during rollout. */
export async function untilJson(url: string, init?: RequestInit) {
  for (let tries = 0; ; tries += 1) {
    const response = await fetch(url, init);
    const text = await response.text();
    if (response.headers.get('Content-Type')?.includes('json')) return JSON.parse(text) as unknown;
    if (tries === 30) throw new Error(`Expected JSON response: ${response.status} ${text.slice(0, 200)}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
