import { execFileSync } from 'node:child_process';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);

/** 相对 HEAD 有改动（含暂存）和未跟踪的文件；已删除的无从检查 */
export function changedFiles(cwd: string): string[] {
  return [...git(cwd, 'diff', '--name-only', '--diff-filter=d', 'HEAD'), ...git(cwd, 'ls-files', '--others', '--exclude-standard')].sort();
}
