import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inScratchDir, runTool } from '../check/gates.ts';
import { inputsHash, passedCache } from './model-cache.ts';

// Slow gates for protocol models: protocols change rarely once specified and are excluded from pnpm check; run manually when modifying models.
// pnpm model:setup installs TLC into .tools/tlaplus; pnpm model runs all MC*.cfg; pnpm model:big runs exhaustive checks on all .big.cfg (takes minutes to tens of minutes);
// pnpm model:trace validates simulation traces against TracePrivate.tla and TraceShared.tla (see trace).
// Configurations and traces whose inputs match their previous passing run reuse cached results (model-cache.ts, stored in .check/model-cache.json).
// TLC version and hash are pinned so installations across machines are identical; requires Java 11+. Trace validation requires single-pass depth-first search (StateDeque) available only in the v1.8.0 pre-release;
// official pre-release URLs can be overwritten by new builds, so the official master 2ef2af8 build is pinned and hosted under hht/tlaplus-pin release assets.
// @see https://github.com/tlaplus/tlaplus/tree/2ef2af8c767b76e5db5cba2878f027ac07aad36c
// @see https://github.com/hht/tlaplus-pin/releases/tag/tla2tools-2ef2af8

const root = resolve(import.meta.dirname, '../..');
const dir = join(root, 'model');
const jar = join(root, '.tools/tlaplus/tla2tools.jar');
const tlc = {
  url: 'https://github.com/hht/tlaplus-pin/releases/download/tla2tools-2ef2af8/tla2tools.jar',
  sha256: 'd15655eeaff4b3f7b3d65c46b838bc0f35d131b2ef4b1e473689b62c98d4726f',
};

/** Downloads and verifies hash: aborts if hash mismatches to avoid installing altered binaries. */
async function setup() {
  const response = await fetch(tlc.url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${tlc.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== tlc.sha256) throw new Error(`Hash mismatch: ${tlc.url}\n  expected ${tlc.sha256}\n  got ${actual}`);
  mkdirSync(dirname(jar), { recursive: true });
  writeFileSync(jar, bytes);
  console.log(`Installed: ${jar}`);
}

/**
 * Maximum worker threads per configuration: TLC workers share a state queue and seen-state table, causing contention when thread counts are high.
 * Benchmarked locally (M5 Pro, 18 cores): an 840k-state model took 10s on 8 cores, 8s on 12 cores, 7s on 18 cores;
 * an 18.5M-state model took 292s on 9 cores and 299s on 18 cores. Allocating more cores yields no benefit for large models while consuming host resources.
 * @see https://groups.google.com/g/tlaplus/c/pi5B8YaJzcI
 */
const modelWorkers = 8;

/** Plan module and execution flags for a configuration: random walk by duration if specified in header, otherwise exhaustive check. */
function planOf(cfg: string) {
  const seconds = readFileSync(join(dir, cfg), 'utf8').match(/Gate mode: random walk for (\d+)s/)?.[1];
  // Configurations defining custom constants (key ordering for shared spaces) have a matching .tla; otherwise checks Private.tla directly.
  const named = cfg.replace(/(\.big)?\.cfg$/, '');
  const module = existsSync(join(dir, `${named}.tla`)) ? named : 'Private';
  const mode = seconds ? [`-Dtlc2.TLC.stopAfter=${seconds}`] : [];
  const run = seconds ? ['-simulate', '-depth', '80'] : [];
  return { seconds, module, mode, run };
}

/**
 * Runs TLC against a model configuration: random walk if the header specifies "Gate mode: random walk for Ns" (state space too large for exhaustive search),
 * otherwise exhaustive check. Property violations, syntax, or semantic errors are reported on line 1 of the cfg file with TLC's first error;
 * the full counterexample is in the log.
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
        if (error) return [{ file: `model/${cfg}`, line: 1, rule: 'model', message: `TLC: ${error}` }];
        return done ? [] : [{ file: `model/${cfg}`, line: 1, rule: 'model', message: 'TLC did not finish; see log' }];
      },
    );
  });

/** Runs configurations sequentially, each using up to modelWorkers cores; exits with failure if any configuration fails. */
async function check(pattern: RegExp) {
  if (!existsSync(jar)) throw new Error('TLA+ tools not installed; run pnpm model:setup first');
  let ok = true;
  const cache = passedCache(cacheFile);
  const tool = toolInputs();
  for (const cfg of readdirSync(dir)
    .filter((file) => pattern.test(file))
    .sort()) {
    // Random walks are never cached: each run is short and re-running explores different paths.
    const { seconds, module } = planOf(cfg);
    const hash = seconds ? '' : inputsHash([dir], module, join(dir, cfg), tool);
    if (!seconds && cache.reusable(cfg, hash)) {
      console.log(`♻️  ${cfg} inputs unchanged; reusing cached pass`);
      continue;
    }
    const started = Date.now();
    const result = await checkModel(cfg);
    if (!seconds) cache.record(cfg, hash, result.ok);
    ok &&= result.ok;
    // Distinct states count from TLC's summary line; documented in the configuration header.
    const states = result.output.match(/([\d,]+) distinct states found, 0 states left on queue/)?.[1];
    const time = `${Math.round((Date.now() - started) / 1000)}s${states ? `, ${states} states` : ''}`;
    console.log(result.ok ? `✅ ${cfg} ${time}` : `❌ ${cfg} ${time}\n${result.problems.map((p) => `   ${p.message}`).join('\n')}`);
  }
  process.exitCode = ok ? 0 : 1;
}

/** Cached passing configurations and traces: name -> input hash (model-cache.ts) */
const cacheFile = join(root, '.check/model-cache.json');
/**
 * Inputs determining model check conclusions beyond model files: installed TLC jar hash, execution/pass evaluation logic
 * (this file and gates.ts runTool), and cache hash computation (model-cache.ts). Any change invalidates cached results.
 */
const toolInputs = () => ({
  tlc: createHash('sha256').update(readFileSync(jar)).digest('hex'),
  runner: [import.meta.filename, join(import.meta.dirname, 'model-cache.ts'), join(import.meta.dirname, '../check/gates.ts')].map((file) =>
    readFileSync(file, 'utf8'),
  ),
});

/**
 * Parallel trace validation concurrency and per-trace JVM heap limit: each trace runs one TLC instance on a single core,
 * typically using 1-3 GB; without limits each JVM defaults to 1/4 host RAM, which previously exhausted 64 GB host RAM
 * when running 18 instances concurrently. 4 workers * 6 GB caps total usage at 24 GB; each uses single-pass DFS (StateDeque).
 */
const traceJobs = 4;
const traceJvm = ['-Xmx6g', '-Dtlc2.tool.queue.IStateQueue=StateDeque', '-XX:+UseParallelGC'];

/**
 * Per-trace TLC arguments: 1 worker (matched trace progress is tracked via TLCSet on a single worker); no checkpointing
 * (unsupported by StateDeque and errors after default 30min checkpoint interval); suppresses TE spec generation in model dir
 * (each matching step violates the Unmatched invariant, which would otherwise emit multi-megabyte *_TTrace_* specs).
 * @see https://github.com/tlaplus/tlaplus/blob/2ef2af8c767b76e5db5cba2878f027ac07aad36c/tlatools/org.lamport.tlatools/src/tlc2/tool/queue/StateDeque.java
 */
const traceTlc = ['-workers', '1', '-checkpoint', '0', '-noGenerateSpecTE'];

/** Maximum execution time per trace (ms): in DFS mode, each of the ~800 traces finishes within 8s locally. Exceeding this is treated as unmatched. */
const traceTimeout = 10 * 60_000;

/** Executes a command; returns output even on timeout, error, or signal termination. */
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

/** Runs private and shared space simulations, recording seed traces under scratch/traces/<seed>; returns trace directory and seed names. */
async function recordTraces(scratch: string) {
  const traces = join(scratch, 'traces');
  const simulations = ['src/test/simulation', 'src/test/shared-simulation.test.ts'];
  const simulated = await exec('pnpm', ['vitest', 'run', '--project', 'fast', ...simulations], {
    cwd: root,
    env: { SIMULATION_TRACE: traces },
  });
  if (!simulated.ok) throw new Error(`Simulation failed:\n${simulated.output}`);
  return { traces, seeds: readdirSync(traces).sort() };
}

/** Model checking spec for each space type; results are reported separately. */
const spaces = { TracePrivate: 'private space', TraceShared: 'shared space' } as const;
const specOf = (seed: string): keyof typeof spaces => (seed.startsWith('shared-') ? 'TraceShared' : 'TracePrivate');

/** Validates a single trace: reuses cached pass if inputs are unchanged; aborted runs yield no conclusion; failed traces write full output to .check/. */
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
  // A trace is truly unmatched only after search finishes; timeouts or errors indicate incomplete searches.
  const searched = /^Finished in /m.test(output) ? '' : ', timed out or errored before completing search';
  return { failed: `${seed}: matched ${matched}/${lines} steps${searched} (TLC output in .check/trace-${seed}.log)` };
}

/**
 * Trace validation (following Microsoft CCF trace validation): deterministic simulation records execution traces per seed,
 * one for private spaces (src/test/test-trace.ts, validated against TracePrivate.tla) and one per device for shared spaces
 * (src/test/test-shared-trace.ts, validated against TraceShared.tla); TLC searches for an execution matching every step,
 * where a match violates the Unmatched invariant. Seeds match simulation defaults (starting from SIMULATION_SEED, default 0);
 * runs traceJobs workers in parallel, each using an isolated scratch directory (TLC unpacks standard modules into tmpdir, causing collisions if shared).
 * Uses single-pass depth-first search (StateDeque): once a matching execution is found, BFS would unnecessarily expand all paths at that depth.
 * A reported match is always a valid execution of the model regardless of search order; a reported mismatch requires exhausting the state space under VIEW,
 * where representative states under TraceView (which omits dWant) depend on traversal order. -dfid is avoided as it re-explores iteratively and is slower than BFS.
 * If a trace fails for a space type, remaining runs for that space type abort: a single mismatch disproves refinement, and exhaustive search for mismatches
 * is the slowest path.
 * @see https://arxiv.org/pdf/2406.17455 §6.4
 * @see https://github.com/tlaplus/tlaplus/blob/2ef2af8c767b76e5db5cba2878f027ac07aad36c/tlatools/org.lamport.tlatools/src/tlc2/tool/queue/IStateQueue.java
 */
async function trace() {
  if (!existsSync(jar)) throw new Error('TLA+ tools not installed; run pnpm model:setup first');
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
          ? `✅ ${spaces[spec]} all ${space.total} traces matched (${space.reused} reused from cache)`
          : `❌ ${spaces[spec]} ${space.failed.length} trace(s) unmatched, stopped (${unchecked}/${space.total} unchecked)\n${space.failed.join('\n')}`,
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
else throw new Error('Usage: node tools/dev/model.ts setup | check | big | trace');
