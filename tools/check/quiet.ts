import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const failure = /error|fail|✗|×|✕/i;
const tail = 30;

type Run = { command: string; code: number; seconds: number; output: string; outputFile: string };

/** 成功一行；失败给出错的行加最后 30 行，按原顺序、不重复 */
export function summarize({ command, code, seconds, output, outputFile }: Run): string[] {
  if (code === 0) return [`✓ ${command} ${seconds}s 日志 ${outputFile}`];
  const lines = stripVTControlCharacters(output).trimEnd().split('\n');
  const kept = lines.filter((line, index) => index >= lines.length - tail || failure.test(line));
  return [...kept, `✗ ${command} 退出码 ${code} ${seconds}s 日志 ${outputFile}`];
}

if (import.meta.main) {
  const [file = '', ...args] = process.argv.slice(2);
  const root = resolve(import.meta.dirname, '../..');
  const started = performance.now();
  const child = spawn(file, args, { stdio: ['inherit', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  child.on('close', (exitCode) => {
    const code = exitCode ?? 1;
    mkdirSync(join(root, '.q'), { recursive: true });
    const outputFile = join(root, '.q', `${Date.now()}.log`);
    writeFileSync(outputFile, output);
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    for (const line of summarize({
      command: [file, ...args].join(' '),
      code,
      seconds,
      output,
      outputFile: relative(process.cwd(), outputFile),
    }))
      console.log(line);
    process.exitCode = code;
  });
}
