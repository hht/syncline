import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { changedFiles } from './changed-files.ts';

test('selects modified, staged, and untracked files relative to HEAD, excluding deleted and ignored files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'changed-'));
  onTestFinished(() => rmSync(dir, { recursive: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q');
  for (const name of ['kept.ts', 'edited.ts', 'staged.ts', 'deleted.ts']) writeFileSync(join(dir, name), '');
  writeFileSync(join(dir, '.gitignore'), 'ignored.ts\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  writeFileSync(join(dir, 'edited.ts'), 'x');
  writeFileSync(join(dir, 'staged.ts'), 'x');
  git('add', 'staged.ts');
  git('rm', '-q', 'deleted.ts');
  writeFileSync(join(dir, 'new.ts'), '');
  writeFileSync(join(dir, 'ignored.ts'), '');
  expect(changedFiles(dir)).toEqual(['edited.ts', 'new.ts', 'staged.ts']);
});
