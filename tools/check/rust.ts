import { globSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { runTool, together } from './gates.ts';
import type { Problem } from './problem.ts';
import type { GateResult } from './run-gates.ts';

type CargoMessage = {
  reason: string;
  message?: { message: string; code: { code: string } | null; spans: { file_name: string; line_start: number; is_primary: boolean }[] };
};

/** 工具报的文件：相对工作区的接上 dir；绝对路径（rustfmt、文档测试、宏展开到工作区外）照解析过软链的 root 算 */
const located = (root: string, dir: string, file: string) => (isAbsolute(file) ? relative(realpathSync(root), file) : join(dir, file));

/**
 * clippy 的 json 输出：cargo 的消息每行一个、都以 {"reason" 开头，其余是混进来的标准错误；--all-targets 时库与它的测试各编一遍，
 * 同一处会报两次；没有位置的是汇总（「因前面的错误中止」）
 * @see https://doc.rust-lang.org/1.99.1/cargo/reference/external-tools.html#json-messages
 */
function clippyProblems(root: string, dir: string, output: string) {
  const problems = new Map<string, Problem>();
  for (const line of output.split('\n')) {
    if (!line.startsWith('{"reason"')) continue;
    const { reason, message }: CargoMessage = JSON.parse(line);
    const span = message?.spans.find((s) => s.is_primary);
    if (reason !== 'compiler-message' || !message || !span) continue;
    const problem = {
      file: located(root, dir, span.file_name),
      line: span.line_start,
      rule: message.code?.code ?? 'rustc',
      message: message.message,
    };
    problems.set(JSON.stringify(problem), problem);
  }
  return [...problems.values()];
}

/** 两个目标都编的代码两遍 clippy 都报：同一处只留一条 */
const distinct = (result: GateResult): GateResult => ({
  ...result,
  problems: [...new Map(result.problems.map((problem) => [JSON.stringify(problem), problem])).values()],
});

const maxLines = 300;

/**
 * 文件至多 300 行，与 TS 同一个数、同样的数法（biome 的 noExcessiveLinesPerFile：末尾换行之后不算一行）；clippy 没有这条。
 * 末尾的单元测试模块（#[cfg(test)] 下的 mod tests）另算，同样至多 300 行：TS 的测试在单独的文件里，也受这条限。
 * 超了按问题拆成子模块，一个类型的 impl 可以分在几个子模块里（子模块读得到父模块的私有字段）
 * @see https://biomejs.dev/linter/rules/no-excessive-lines-per-file/
 */
function longFiles(root: string, dir: string): Problem[] {
  return globSync('**/*.rs', { cwd: join(root, dir), exclude: (path) => path === 'target' })
    .sort()
    .flatMap((path) => {
      const lines = readFileSync(join(root, dir, path), 'utf8')
        .replace(/\n$/, '')
        .split('\n');
      const tests = lines.findIndex((line, index) => line === '#[cfg(test)]' && lines[index + 1] === 'mod tests {');
      const parts =
        tests === -1
          ? [{ start: 0, count: lines.length }]
          : [
              { start: 0, count: tests },
              { start: tests, count: lines.length - tests },
            ];
      return parts
        .filter(({ count }) => count > maxLines)
        .map(({ start, count }) => ({
          file: join(dir, path),
          line: start + 1,
          rule: 'max-lines',
          message: `${start === 0 ? '文件' : '测试模块'} ${count} 行，超过 ${maxLines}：按问题拆成子模块`,
        }));
    });
}

/** 另对一个目标跑 clippy 的包：只在那个目标上编的代码（cfg(target_family = "wasm") 下的）在本机目标上不查；env 是编那个目标要设的环境（用到时才取，取不到就抛错） */
type Cross = { target: string; package: string; env: () => Record<string, string> };

/**
 * Rust 工作区（dir 相对 root）：文件行数、格式、clippy（警告即错）、测试，报出的文件相对 root；--locked：Cargo.toml 改了没更新锁文件就报错，不悄悄改写它。
 * 给了 cross 就另对它的目标跑两遍 clippy：不开功能（发布的构建）与开全部功能（测试的构建），两种编出的代码不同，都查。
 * 用 rustup 的 cargo 代理，版本只认工作区的 rust-toolchain.toml；mise 的 rust 会设 RUSTUP_TOOLCHAIN 盖过它，这里清掉
 * @see https://rust-lang.github.io/rustup/overrides.html 覆盖的优先级
 * @see https://rust-lang.github.io/rustup/installation/index.html 代理装在 CARGO_HOME/bin，默认 ~/.cargo
 */
export const rust = (root: string, dir: string, cross?: Cross) => async () => {
  const cargo = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin', 'cargo');
  const run = (args: string[], parse: (output: string) => Problem[], env: Record<string, string> = {}) =>
    runTool(join(root, dir), cargo, args, parse, { RUSTUP_TOOLCHAIN: '', ...env });
  const clippy = (args: string[], env?: Record<string, string>) =>
    run(
      ['clippy', '--locked', ...args, '--message-format=json', '--', '-D', 'warnings'],
      (output) => clippyProblems(root, dir, output),
      env,
    );
  const crossClippy = async ({ target, package: name, env }: Cross) => {
    let compilers: Record<string, string>;
    try {
      compilers = env();
    } catch (error) {
      // 只记成这一项失败，不让整次检查崩掉、没有汇总
      const message = error instanceof Error ? error.message : String(error);
      return [{ ok: false, output: message, problems: [{ file: dir, line: 1, rule: 'clippy-target', message }] }];
    }
    const args = ['-p', name, '--target', target];
    return [await clippy(args, compilers), await clippy([...args, '--all-features'], compilers)];
  };
  // clippy 与测试共用编译目录，并行也会在锁上排队；格式不到一秒，三步依次跑
  const long = longFiles(root, dir);
  return together([
    { ok: long.length === 0, output: long.map((p) => `${p.file}:${p.line} ${p.message}`).join('\n'), problems: long },
    // rustfmt 的输出带颜色
    await run(['fmt', '--check'], (output) =>
      [...stripVTControlCharacters(output).matchAll(/^Diff in (.+):(\d+):$/gm)].map(([, file = '', line = '']) => ({
        file: located(root, dir, file),
        line: Number(line),
        rule: 'rustfmt',
        message: '格式不对，跑 cargo fmt',
      })),
    ),
    // --all-features：只在测试构建打开的代码（如注入故障）也查
    distinct(together([await clippy(['--all-targets', '--all-features']), ...(cross ? await crossClippy(cross) : [])])),
    await run(['test', '--locked'], (output) =>
      [...output.matchAll(/^thread '(.+?)' .*panicked at (.+?):(\d+):\d+:\n(.*)$/gm)].map(
        ([, name = '', file = '', line = '', message = '']) => ({
          file: located(root, dir, file),
          line: Number(line),
          rule: 'cargo-test',
          message: `${name}：${message}`,
        }),
      ),
    ),
  ]);
};
