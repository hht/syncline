import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inScratchDir, runTool } from '../check/gates.ts';
import { inputsHash, passedCache } from './model-cache.ts';

// 协议模型的慢门禁：协议定下来后很少改，不进 pnpm check，改模型时手动跑。
// pnpm model:setup 装 TLC 到 .tools/tlaplus；pnpm model 跑全部 MC*.cfg；pnpm model:big 完整穷举全部 .big.cfg（几分钟到几十分钟）；
// pnpm model:trace 做轨迹核对（模拟记下的轨迹逐条交给 TracePrivate.tla，见 trace）。
// 输入没变、上次通过了的配置与轨迹沿用上次的结论（model-cache.ts，记在 .check/model-cache.json）。
// TLC 版本与哈希钉死，每台机器装出来一样；要 Java 11 以上。轨迹核对要的单次深度优先（StateDeque）只在 v1.8.0 预发布版里有，
// 官方的预发布同一地址会被新构建覆盖，所以把官方 master 2ef2af8 的构建原样存在 hht/tlaplus-pin 的 release 里、从那里装
// @see https://github.com/tlaplus/tlaplus/tree/2ef2af8c767b76e5db5cba2878f027ac07aad36c
// @see https://github.com/hht/tlaplus-pin/releases/tag/tla2tools-2ef2af8

const root = resolve(import.meta.dirname, '../..');
const dir = join(root, 'model');
const jar = join(root, '.tools/tlaplus/tla2tools.jar');
const tlc = {
  url: 'https://github.com/hht/tlaplus-pin/releases/download/tla2tools-2ef2af8/tla2tools.jar',
  sha256: 'd15655eeaff4b3f7b3d65c46b838bc0f35d131b2ef4b1e473689b62c98d4726f',
};

/** 下载并核对哈希：对不上就是版本被换过，不装 */
async function setup() {
  const response = await fetch(tlc.url);
  if (!response.ok) throw new Error(`下载失败：${response.status} ${tlc.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== tlc.sha256) throw new Error(`哈希对不上：${tlc.url}\n  要 ${tlc.sha256}\n  得 ${actual}`);
  mkdirSync(dirname(jar), { recursive: true });
  writeFileSync(jar, bytes);
  console.log(`装好了：${jar}`);
}

/**
 * 一份配置至多用几个核：TLC 的 worker 共用一个待查队列与已见状态表，核多了互相等。本机（M5 Pro，18 核）实测：
 * 84 万状态的配置 8 核 10 秒、12 核 8 秒、18 核 7 秒；1850 万状态的配置 9 核 292 秒、18 核 299 秒。大配置多给核没有收益，留一大半给别的活
 * @see https://groups.google.com/g/tlaplus/c/pi5B8YaJzcI
 */
const modelWorkers = 8;

/** 一份配置查哪个模块、怎么跑：配置首部写了随机游走的按时随机游走，其余完整穷举 */
function planOf(cfg: string) {
  const seconds = readFileSync(join(dir, cfg), 'utf8').match(/门禁方式：随机游走 (\d+) 秒/)?.[1];
  // 配置要另定常量的（共用空间的键的次序）有同名的 .tla，其余直接查私有空间的 Private.tla
  const named = cfg.replace(/(\.big)?\.cfg$/, '');
  const module = existsSync(join(dir, `${named}.tla`)) ? named : 'Private';
  const mode = seconds ? [`-Dtlc2.TLC.stopAfter=${seconds}`] : [];
  const run = seconds ? ['-simulate', '-depth', '80'] : [];
  return { seconds, module, mode, run };
}

/**
 * TLC 跑一份模型配置：配置首部写了「门禁方式：随机游走 N 秒」的按时随机游走（状态太多，穷举跑不完），其余完整穷举。
 * 违反性质、语法或语义错误都报在配置第 1 行，带上 TLC 的第一条错误；完整反例在日志里
 */
const checkModel = (cfg: string) =>
  inScratchDir((scratch) => {
    const { seconds, module, mode, run } = planOf(cfg);
    const workers = String(Math.min(modelWorkers, availableParallelism()));
    return runTool(
      dir,
      'java',
      [
        ...mode,
        `-Djava.io.tmpdir=${scratch}`,
        '-XX:+UseParallelGC',
        '-cp',
        jar,
        'tlc2.TLC',
        '-workers',
        workers,
        '-deadlock',
        '-noGenerateSpecTE',
        ...run,
        '-metadir',
        scratch,
        '-config',
        cfg,
        module,
      ],
      (output) => {
        const error = output.match(/^Error: (.+)$/m)?.[1] ?? output.match(/\*\*\* ?(Parse Error|Semantic errors?)/i)?.[1];
        const done = seconds ? /^Finished in /m.test(output) : output.includes('Model checking completed. No error has been found.');
        if (error) return [{ file: `model/${cfg}`, line: 1, rule: 'model', message: `TLC：${error}` }];
        return done ? [] : [{ file: `model/${cfg}`, line: 1, rule: 'model', message: 'TLC 没跑完，见日志' }];
      },
    );
  });

/** 一份一份跑，每份至多 modelWorkers 个核；有一份不过就以失败退出 */
async function check(pattern: RegExp) {
  if (!existsSync(jar)) throw new Error('没装 TLA+ 工具：先跑 pnpm model:setup');
  let ok = true;
  const cache = passedCache(cacheFile);
  const tool = toolInputs();
  for (const cfg of readdirSync(dir)
    .filter((file) => pattern.test(file))
    .sort()) {
    // 随机游走不复用：每次跑要的时间短，重跑还会走到别的路径
    const { seconds, module } = planOf(cfg);
    const hash = seconds ? '' : inputsHash([dir], module, join(dir, cfg), tool);
    if (!seconds && cache.reusable(cfg, hash)) {
      console.log(`♻️  ${cfg} 输入没变，沿用上次的通过`);
      continue;
    }
    const started = Date.now();
    const result = await checkModel(cfg);
    if (!seconds) cache.record(cfg, hash, result.ok);
    ok &&= result.ok;
    // 完整穷举的状态数照 TLC 最后一行，配置首部照它写
    const states = result.output.match(/([\d,]+) distinct states found, 0 states left on queue/)?.[1];
    const time = `${Math.round((Date.now() - started) / 1000)}s${states ? `，${states} 个状态` : ''}`;
    console.log(result.ok ? `✅ ${cfg} ${time}` : `❌ ${cfg} ${time}\n${result.problems.map((p) => `   ${p.message}`).join('\n')}`);
  }
  process.exitCode = ok ? 0 : 1;
}

/** 通过了的配置与轨迹：名字 → 输入的哈希（model-cache.ts） */
const cacheFile = join(root, '.check/model-cache.json');
/**
 * 除了模型本身，还有哪些会改变结论：装着的 TLC（jar 本身的哈希，手动换过的也算），怎么跑、怎么判通过（这个文件与 gates.ts 的 runTool），
 * 怎么算输入（model-cache.ts）。改了哪个，旧的结论都不算
 */
const toolInputs = () => ({
  tlc: createHash('sha256').update(readFileSync(jar)).digest('hex'),
  runner: [import.meta.filename, join(import.meta.dirname, 'model-cache.ts'), join(import.meta.dirname, '../check/gates.ts')].map((file) =>
    readFileSync(file, 'utf8'),
  ),
});

/**
 * 同时核对几条轨迹、每条的堆上限：每条一个 TLC、一个核，多数用 1–3 GB；不设上限时每个 JVM 默认可拿 1/4 内存，
 * 按核数同时跑（18 个）撑爆过 64 GB 的开发机。4 条乘 6 GB 至多 24 GB；每条用单次深度优先（StateDeque，见 trace）
 */
const traceJobs = 4;
const traceJvm = ['-Xmx6g', '-Dtlc2.tool.queue.IStateQueue=StateDeque', '-XX:+UseParallelGC'];

/**
 * 每条轨迹的 TLC 参数：一个 worker（「对上了几条」靠单个 worker 的 TLCSet 记）；不存档（StateDeque 不支持，到默认的 30 分钟会抛错）；
 * 不在模型目录写 TE spec（对上就是违反不变量，每条都会写一份几 MB 的 *_TTrace_*）
 * @see https://github.com/tlaplus/tlaplus/blob/2ef2af8c767b76e5db5cba2878f027ac07aad36c/tlatools/org.lamport.tlatools/src/tlc2/tool/queue/StateDeque.java
 */
const traceTlc = ['-workers', '1', '-checkpoint', '0', '-noGenerateSpecTE'];

/** 一条轨迹至多核对多久（毫秒）：深度优先下 800 条每条至多 8 秒（实测）。超过就当没对上、报出来 */
const traceTimeout = 10 * 60_000;

/** 跑一条命令；超时、出错、被 signal 停掉都照样给出输出 */
const exec = (
  file: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; timeout?: number; signal?: AbortSignal },
) =>
  new Promise<{ ok: boolean; aborted: boolean; output: string }>((done) =>
    execFile(file, args, { ...options, env: { ...process.env, ...options.env }, maxBuffer: 1 << 28 }, (error, stdout, stderr) =>
      done({ ok: !error, aborted: error?.name === 'AbortError', output: stdout + stderr }),
    ),
  );

/** 跑私有、共用空间的模拟，每个种子的轨迹记到 scratch/traces 下以它命名的目录里；给出这个目录与这些名字 */
async function recordTraces(scratch: string) {
  const traces = join(scratch, 'traces');
  const simulations = ['src/test/simulation', 'src/test/shared-simulation.test.ts'];
  const simulated = await exec('pnpm', ['vitest', 'run', '--project', 'fast', ...simulations], {
    cwd: root,
    env: { SIMULATION_TRACE: traces },
  });
  if (!simulated.ok) throw new Error(`模拟没跑过：\n${simulated.output}`);
  return { traces, seeds: readdirSync(traces).sort() };
}

/** 两种空间各自交给哪个模块核对，结论分开报 */
const spaces = { TracePrivate: '私有空间', TraceShared: '共用空间' } as const;
const specOf = (seed: string): keyof typeof spaces => (seed.startsWith('shared-') ? 'TraceShared' : 'TracePrivate');

/** 核对一条轨迹：输入没变就沿用上次的通过；被 signal 停掉的没有结论；没对上的给出报告（完整输出写到 .check/） */
async function checkTrace(
  seed: string,
  run: { scratch: string; traces: string; cache: ReturnType<typeof passedCache>; tool: ReturnType<typeof toolInputs>; signal: AbortSignal },
) {
  const library = join(run.traces, seed);
  const spec = specOf(seed);
  const hash = inputsHash([dir, library], spec, join(dir, `${spec}.cfg`), run.tool);
  const name = `trace-${seed}`;
  if (run.cache.reusable(name, hash)) return 'reused';
  const work = join(run.scratch, `tlc-${seed}`);
  mkdirSync(work);
  const args = [...traceJvm, `-Djava.io.tmpdir=${work}`, `-DTLA-Library=${library}`, '-cp', jar, 'tlc2.TLC', ...traceTlc];
  const { output, aborted } = await exec('java', [...args, '-metadir', work, '-config', `${spec}.cfg`, spec], {
    cwd: dir,
    timeout: traceTimeout,
    signal: run.signal,
  });
  rmSync(work, { recursive: true, force: true });
  const passed = output.includes('Invariant Unmatched is violated');
  if (!passed && aborted) return 'stopped';
  run.cache.record(name, hash, passed);
  if (passed) return 'passed';
  const lines = readFileSync(join(library, 'TraceLog.tla'), 'utf8').match(/\[step \|->/g)?.length ?? 0;
  const matched = [...output.matchAll(/"matched", (\d+)/g)].at(-1)?.[1] ?? '0';
  mkdirSync(join(root, '.check'), { recursive: true });
  writeFileSync(join(root, `.check/trace-${seed}.log`), output);
  // 查完了才是真的对不上；超时、内存不够没查完的，只知道还没找到
  const searched = /^Finished in /m.test(output) ? '' : '，超时或出错、没查完';
  return { failed: `${seed}：对上了 ${matched}/${lines} 条${searched}（TLC 输出在 .check/trace-${seed}.log）` };
}

/**
 * 轨迹核对（照 Microsoft CCF 的 trace validation）：确定性模拟每个种子记下轨迹，私有空间一条（src/test/test-trace.ts，
 * 交给 TracePrivate.tla），共用空间每台设备一条（src/test/test-shared-trace.ts，交给 TraceShared.tla）；TLC 找一条每一步都对得上的
 * 模型执行，对上了是不变量 Unmatched 被违反。种子照模拟（SIMULATION_SEED 起，默认 0）；
 * 同时跑 traceJobs 个，每个用自己的临时目录（TLC 把标准模块解到临时目录，同时跑会互相写坏）。
 * 用单次深度优先（StateDeque）：只要找到一条对得上的执行，广度优先会把同一深度的路全展开。报对上的一定是模型的一条真实执行，与搜索次序无关；
 * 报没对上的要把 VIEW 下的状态空间查完，VIEW 认作同一个的状态（TracePrivate.tla 的 TraceView 不看 dWant）留哪个代表随次序，两种搜索可能不同。
 * 不用 -dfid，它逐层加深、每层从头重搜，比广度优先还慢。
 * 一种空间里一条没对上，这种空间就停：后面的不再起，正在跑的停掉；另一种照常核对。一条对不上已经说明实现与模型没对齐，
 * 没对上的要把可能的执行全部走完才下结论，是最慢的，其余的只是多等
 * @see https://arxiv.org/pdf/2406.17455 §6.4
 * @see https://github.com/tlaplus/tlaplus/blob/2ef2af8c767b76e5db5cba2878f027ac07aad36c/tlatools/org.lamport.tlatools/src/tlc2/tool/queue/IStateQueue.java
 */
async function trace() {
  if (!existsSync(jar)) throw new Error('没装 TLA+ 工具：先跑 pnpm model:setup');
  const scratch = mkdtempSync(join(tmpdir(), 'syncline-trace-'));
  try {
    const { traces, seeds } = await recordTraces(scratch);
    const cache = passedCache(cacheFile);
    const tool = toolInputs();
    const tally = () => ({ stop: new AbortController(), total: 0, reused: 0, checked: 0, failed: [] as string[] });
    const runs = { TracePrivate: tally(), TraceShared: tally() };
    for (const seed of seeds) runs[specOf(seed)].total += 1;
    const queue = [...seeds];
    await Promise.all(
      Array.from({ length: traceJobs }, async () => {
        for (let seed = queue.shift(); seed !== undefined; seed = queue.shift()) {
          const space = runs[specOf(seed)];
          if (space.stop.signal.aborted) continue;
          const result = await checkTrace(seed, { scratch, traces, cache, tool, signal: space.stop.signal });
          if (result === 'reused') space.reused += 1;
          else if (result !== 'stopped') space.checked += 1;
          if (typeof result === 'object') {
            space.failed.push(result.failed);
            space.stop.abort();
          }
        }
      }),
    );
    for (const [spec, space] of Object.entries(runs) as [keyof typeof spaces, ReturnType<typeof tally>][]) {
      const unchecked = space.total - space.reused - space.checked;
      console.log(
        space.failed.length === 0
          ? `✅ ${spaces[spec]} ${space.total} 条轨迹都对上了（${space.reused} 条输入没变，沿用上次的）`
          : `❌ ${spaces[spec]} ${space.failed.length} 条没对上，停下了（${unchecked}/${space.total} 条没核对）\n${space.failed.join('\n')}`,
      );
    }
    process.exitCode = Object.values(runs).some((space) => space.failed.length > 0) ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const command = process.argv[2];
if (command === 'setup') await setup();
else if (command === 'check') await check(/^MC\w+\.cfg$/);
else if (command === 'big') await check(/\.big\.cfg$/);
else if (command === 'trace') await trace();
else throw new Error('用法：node tools/dev/model.ts setup | check | big | trace');
