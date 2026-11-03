import { execFileSync } from 'node:child_process';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);

/** Returns files modified, staged, or untracked relative to HEAD, excluding deleted files. */
export function changedFiles(cwd: string): string[] {
  return [...git(cwd, 'diff', '--name-only', '--diff-filter=d', 'HEAD'), ...git(cwd, 'ls-files', '--others', '--exclude-standard')].sort();
}
