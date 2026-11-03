import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { Problem } from './problem.ts';
import type { GateResult } from './run-gates.ts';

const bin = (name: string) => resolve(import.meta.dirname, '../../node_modules/.bin', name);

/** 给一次运行一个临时目录，用完删掉 */
export async function inScratchDir(run: (dir: string) => Promise<GateResult>) {
  const dir = mkdtempSync(join(tmpdir(), 'syncline-check-'));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 跑一个命令，输出交给 parse 转成问题；有的工具有问题也返回 0，所以两者都要看 */
export function runTool(
  cwd: string,
  file: string,
  args: string[],
  parse: (output: string) => Problem[],
  env?: Record<string, string>,
): Promise<GateResult> {
  return new Promise((done) => {
    execFile(file, args, { cwd, maxBuffer: 1 << 28, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      // 命令本身起不来（没装、不在路径上）时两路输出都是空的，日志里写上错误
      const output = stdout + stderr || (error?.message ?? '');
      const problems = parse(output);
      done({ ok: !error && problems.length === 0, output, problems });
    });
  });
}

/** 几次运行合成一个门禁结果：都通过才通过 */
export const together = (results: GateResult[]): GateResult => ({
  ok: results.every((result) => result.ok),
  output: results.map((result) => result.output).join('\n'),
  problems: results.flatMap((result) => result.problems),
});

type BiomeReport = { diagnostics: { category: string; message: string; location: { path: string; start: { line: number } } }[] };

export const biome = (cwd: string) => (files: string[] | undefined) =>
  runTool(cwd, bin('biome'), ['check', '--reporter=json', '--no-errors-on-unmatched', ...(files ?? ['.'])], (output) => {
    // 配置出错时没有报告，交给调度器指向日志
    const start = output.indexOf('{"summary"');
    if (start === -1) return [];
    const report: BiomeReport = JSON.parse(output.slice(start, output.lastIndexOf('}') + 1));
    return report.diagnostics.map(({ category, message, location }) => ({
      file: location.path,
      // 格式问题不落在某一行，报告里行号是 0
      line: Math.max(1, location.start.line),
      rule: category,
      message,
    }));
  });

/** 各项目并行跑 tsc；files 不影响范围，类型错误可能出现在没改的文件里 */
export const typecheck = (cwd: string, projects: string[]) => async () => {
  const results = await Promise.all(
    projects.map((project) =>
      runTool(cwd, bin('tsc'), ['-p', project, '--pretty', 'false'], (output) =>
        [...output.matchAll(/^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/gm)].map(([, file = '', line = '', rule = '', message = '']) => ({
          file,
          line: Number(line),
          rule,
          message,
        })),
      ),
    ),
  );
  return together(results);
};

// reachable 规则的违规是经几层间接引用到的，不对应源码里的一条 import，报告里没有 unresolvedTo
type CruiseReport = { summary: { violations: { from: string; to: string; unresolvedTo?: string; rule: { name: string } }[] } };

/** 报告里没有行号，用源码里写的模块路径找回所在行；报告会去掉 node: 前缀 */
function lineOf(cwd: string, file: string, specifier: string) {
  const quoted = new RegExp(`['"](node:)?${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
  return (
    readFileSync(join(cwd, file), 'utf8')
      .split('\n')
      .findIndex((line) => quoted.test(line)) + 1
  );
}

export const layers = (cwd: string, paths: string[]) => () =>
  runTool(cwd, bin('depcruise'), ['--config', '.dependency-cruiser.json', '--output-type', 'json', ...paths], (output) => {
    const start = output.indexOf('{');
    if (start === -1) return [];
    const report: CruiseReport = JSON.parse(output.slice(start));
    return report.summary.violations.map(({ from, to, unresolvedTo, rule }) => ({
      file: from,
      line: unresolvedTo === undefined ? 1 : lineOf(cwd, from, unresolvedTo),
      rule: rule.name,
      message: `引用 ${to}`,
    }));
  });

type KnipReport = { issues: ({ file: string } & Record<string, { name: string; line?: number }[]>)[] };

export const deadCode = (cwd: string) => () =>
  runTool(cwd, bin('knip'), ['--reporter', 'json', '--no-progress'], (output) => {
    const start = output.indexOf('{"issues"');
    if (start === -1) return [];
    const report: KnipReport = JSON.parse(output.slice(start));
    return report.issues.flatMap(({ file, ...kinds }) =>
      Object.entries(kinds).flatMap(([kind, items]) =>
        items.map(({ name, line }) => ({ file, line: line ?? 1, rule: `knip/${kind}`, message: name })),
      ),
    );
  });

type Clone = { name: string; start: number };
type CpdReport = { duplicates: { format: string; firstFile: Clone; secondFile: Clone; lines: number }[] };

/**
 * 报告只写文件不走标准输出；报到第二处，第一处写进说明。
 * import 语句不算：同一模块引入的名字相近时，折行后的长 import 会被当成重复，而它不是重复的逻辑。
 * 只认 import 语句的形状（具名、命名空间、默认导入，可带 type）：jscpd 拿它对整个文件匹配，宽了会从正文里的「import」一直吞到后面的 from；
 * jscpd 按逗号把 --ignore-pattern 拆成几个，模式里的逗号写成 \x2c
 */
const importStatement = "import (type )?(\\{[^};]*\\}|\\* as \\w+|\\w+(\\x2c \\{[^};]*\\})?) from '[^']+';";

/** 查得更严的一块：重复从更少的 token 起就报；ignore 是这一遍不查的文件（glob） */
type Strict = { path: string; minTokens: number; ignore?: string };

/**
 * strict 是查得更严的几块：全部照配置查一遍（含它们与别处之间的），每块再单独按 minTokens 查一遍，几遍报的同一处只算一次
 */
export const duplicates =
  (cwd: string, paths: string[], strict: Strict[] = []) =>
  async (): Promise<GateResult> => {
    const all = clones(cwd, paths, []);
    if (strict.length === 0) return all;
    const runs = strict.map(({ path, minTokens, ignore }) =>
      clones(cwd, [path], ['--min-tokens', String(minTokens), ...(ignore === undefined ? [] : ['--ignore', ignore])]),
    );
    const result = together(await Promise.all([all, ...runs]));
    const seen = new Set<string>();
    const problems = result.problems.filter(({ file, line, message }) => {
      const key = `${file}:${line} ${message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...result, problems };
  };

/** 照 .jscpd.json 查一遍重复，extra 是另加的参数；报告里是绝对路径，报出时换成相对 cwd 的 */
const clones = (cwd: string, paths: string[], extra: string[]) =>
  inScratchDir((out) => {
    const report = join(out, 'jscpd-report.json');
    return runTool(
      cwd,
      bin('jscpd'),
      [
        '--config',
        '.jscpd.json',
        '--ignore-pattern',
        importStatement,
        '--reporters',
        'json',
        '--output',
        out,
        '--silent',
        '--absolute',
        '--exit-code',
        '1',
        ...extra,
        ...paths,
      ],
      () => {
        // 配置出错时没有报告，交给调度器指向日志
        if (!existsSync(report)) return [];
        const { duplicates }: CpdReport = JSON.parse(readFileSync(report, 'utf8'));
        // markdown 按「正文 + 内嵌代码块」分开查，文件名带「:格式」后缀
        // 绝对路径是解析过软链的（macOS 的临时目录在 /private 下）：cwd 也取真实路径
        const name = (clone: Clone, format: string) => relative(realpathSync(cwd), clone.name.replace(`:${format}`, ''));
        return duplicates.map(({ format, firstFile, secondFile, lines }) => ({
          file: name(secondFile, format),
          line: secondFile.start,
          rule: 'jscpd',
          message: `与 ${name(firstFile, format)}:${firstFile.start} 重复 ${lines} 行`,
        }));
      },
    );
  });

type VitestReport = {
  testResults: {
    name: string;
    message: string;
    assertionResults: { fullName: string; status: string; failureMessages: string[]; location?: { line: number } | null }[];
  }[];
};

const firstLine = (text: string) => text.split('\n')[0] ?? '';

/** vitest 的 json 报告：解析出失败的用例；文件加载失败时没有用例结果，报在第 1 行 */
function reportProblems(cwd: string, report: string, rule: string): Problem[] {
  if (!existsSync(report)) return [];
  const { testResults }: VitestReport = JSON.parse(readFileSync(report, 'utf8'));
  return testResults.flatMap(({ name, message, assertionResults }) => {
    const file = relative(cwd, name);
    if (message && !assertionResults.some((result) => result.status === 'failed'))
      return [{ file, line: 1, rule, message: firstLine(message) }];
    return assertionResults
      .filter((result) => result.status === 'failed')
      .map(({ fullName, failureMessages, location }) => ({
        file,
        line: location?.line ?? 1,
        rule,
        message: `${fullName}：${firstLine(failureMessages[0] ?? '')}`,
      }));
  });
}

/**
 * json 报告只写文件，用来解析出问题；default 报告把完整的失败详情（断言差异、调用栈、fast-check 的种子与反例）打到输出里，存进门禁日志，
 * 解析出的问题只有第一行，偶发的失败要靠日志复现。文件加载失败时没有用例结果，报在第 1 行。TMPDIR 指向本次临时目录，vitest 自己的临时文件随之删掉
 */
export const tests = (cwd: string, args: string[]) => () =>
  inScratchDir((dir) => {
    const report = join(dir, 'report.json');
    return runTool(
      cwd,
      bin('vitest'),
      ['run', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`, '--includeTaskLocation', ...args],
      () => reportProblems(cwd, report, 'test'),
      { TMPDIR: dir },
    );
  });
