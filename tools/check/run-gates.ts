import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Problem } from './problem.ts';

/** skipped：这次改动与该门禁无关，没有真跑；log 写明原因 */
export type GateResult = { ok: boolean; output: string; problems: Problem[]; skipped?: true };

/**
 * files 为 undefined 表示查全部文件；icon 标出门禁的类型，输出里一眼能认出是哪一类检查。
 * first：先跑完带它的门禁，其余的再起；给按满核编译的门禁，它们与有 5 秒时限的测试同时跑会把测试挤超时
 */
export type Gate = { name: string; icon: string; first?: true; run: (files: string[] | undefined) => Promise<GateResult> };

const seconds = (since: bigint) => `${(Number(process.hrtime.bigint() - since) / 1e9).toFixed(1)}s`;

/**
 * 分两批并行跑门禁，先跑带 first 的：每个门禁无论成败都出一行结果，按定义顺序列出，失败的带上完整日志的位置、在下面列出问题，最后一行是总结
 */
export async function runGates(gates: Gate[], files: string[] | undefined, outputDir: string) {
  mkdirSync(outputDir, { recursive: true });
  const started = process.hrtime.bigint();
  const runOne = async ({ name, icon, run }: Gate) => {
    const gateStarted = process.hrtime.bigint();
    const result = await run(files);
    const outputFile = join(outputDir, `${name}.log`);
    writeFileSync(outputFile, result.output);
    // 解析器跟不上工具输出时不能静默放行
    const problems =
      !result.ok && result.problems.length === 0
        ? [{ file: outputFile, line: 1, rule: name, message: '工具失败但未解析出问题，看日志' }]
        : result.problems.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    return { name, icon, skipped: result.skipped, output: result.output, outputFile, problems, time: seconds(gateStarted) };
  };
  const early = new Map(gates.filter((gate) => gate.first).map((gate) => [gate, runOne(gate)]));
  await Promise.all(early.values());
  const results = await Promise.all(gates.map((gate) => early.get(gate) ?? runOne(gate)));
  const lines = results.flatMap(({ name, icon, skipped, output, outputFile, problems, time }) => {
    if (skipped) return [`${icon} ${name} ⏭️ 跳过（${output}）`];
    if (problems.length === 0) return [`${icon} ${name} ✅ 通过 ${time}`];
    return [
      `${icon} ${name} ❌ ${problems.length} 处问题 ${time} 日志 ${relative(process.cwd(), outputFile)}`,
      ...problems.map(({ file, line, rule, message }) => `   ${file}:${line} ${rule} ${message}`),
    ];
  });
  const failed = results.filter((result) => !result.skipped && result.problems.length > 0).length;
  const skipped = results.filter((result) => result.skipped).length;
  const passed = results.length - failed - skipped;
  const counts = [failed && `${failed} 项失败`, `${passed} 项通过`, skipped && `${skipped} 项跳过`].filter(Boolean).join('，');
  lines.push(failed ? `❌ ${counts}，用时 ${seconds(started)}` : `✅ 全部通过：${counts}，用时 ${seconds(started)}`);
  return { ok: failed === 0, lines };
}
