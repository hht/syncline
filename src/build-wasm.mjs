import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 把 Rust 的设备一侧（rust/wasm）编成 wasm，生成在 Rust 工作区的 target 下：
 * node 给测试（vitest 的 globalSetup，整次运行一回；打开 testing 功能：测试注入存储故障、直接喂拉取结果与消息），测试经 rustStorage 加载；
 * web 给 Syncline 自带的 Worker（Metro 起来时由 withSyncline 编；按体积优化），Metro 当作源码与资源打包。cargo 是增量编译，没改时一两秒。
 * 用 rustup 的 cargo 代理并清掉 RUSTUP_TOOLCHAIN：版本只认工作区的 rust-toolchain.toml（mise 的 rust 会设它盖过工具链文件）。
 * 编 wasm 版 SQLite 要带 wasm 目标的 clang，系统的 Apple clang 没有：用 mise 装的 LLVM（版本钉在下面，没装时报出安装命令）。
 * 不写进仓库的 mise 配置：那样它的 clang、lldb 会在仓库里盖过 Xcode 的。
 * 在 Rust 工作区里调 cargo：rust/.cargo/config.toml 里编 SQLite 的开关只在那里读得到
 * @see https://rust-lang.github.io/rustup/overrides.html
 * @see https://github.com/Spxg/sqlite-wasm-rs/blob/76b199a85ccc5cc440b44318ede300fd90a794c8/README.md
 * @see https://docs.rs/cc/1/cc/#external-configuration-via-environment-variables（CC_{target}、AR_{target}）
 * @see https://wasm-bindgen.github.io/wasm-bindgen/reference/deployment.html（--target web 与 nodejs）
 */

const llvm = 'github:llvm/llvm-project@llvmorg-23.1.4';
const workspace = resolve(import.meta.dirname, '../rust');
export const wasmOutput = join(workspace, 'target/node');

export const wasmTarget = 'wasm32-unknown-unknown';

/** 编 wasm 目标（含其中的 SQLite）要设的环境：wasm 目标的 clang 与 llvm-ar；门禁对 wasm 目标跑 clippy 也要 @returns {Record<string, string>} */
export function wasmCompilers() {
  let clang;
  try {
    clang = join(execFileSync('mise', ['where', llvm], { encoding: 'utf8' }).trim(), 'bin');
  } catch (error) {
    throw new Error(`编 wasm 版 SQLite 要 LLVM：mise install ${llvm}`, { cause: error });
  }
  const suffix = wasmTarget.replaceAll('-', '_');
  return { [`CC_${suffix}`]: join(clang, 'clang'), [`AR_${suffix}`]: join(clang, 'llvm-ar') };
}

/** 编出 output 用的 wasm：node 给测试，web 给 Syncline 自带的 Worker @param {'node' | 'web'} output */
export function buildWasm(output) {
  const testing = output === 'node';
  const profile = testing ? 'wasm-test' : 'web';
  const cargoBin = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin');
  execFileSync(
    join(cargoBin, 'cargo'),
    [
      'build',
      '--locked',
      '--profile',
      profile,
      '-p',
      'syncline-wasm',
      ...(testing ? ['--features', 'testing'] : []),
      '--target',
      wasmTarget,
    ],
    { cwd: workspace, stdio: 'inherit', env: { ...process.env, RUSTUP_TOOLCHAIN: '', ...wasmCompilers() } },
  );
  const outDir = join(workspace, 'target', output);
  execFileSync(join(cargoBin, 'wasm-bindgen'), [
    '--target',
    testing ? 'nodejs' : 'web',
    // 测试保留函数名（panic 的调用栈看得懂），给 web 的去掉
    ...(testing ? [] : ['--remove-name-section']),
    '--out-dir',
    outDir,
    join(workspace, `target/${wasmTarget}/${profile}/syncline_wasm.wasm`),
  ]);
  // node 的是 CommonJS，而这个包声明成 ES 模块：输出目录另标一下
  if (testing) writeFileSync(join(outDir, 'package.json'), '{ "type": "commonjs" }\n');
}

/** vitest 的 globalSetup */
export default () => buildWasm('node');

// withSyncline 直接跑这个文件编 web 的；带参数 node 编测试用的。接入方从 node_modules 里跑它，Node 不擦那里的 TS 类型，所以写成 JS
if (import.meta.main) buildWasm(process.argv[2] === 'node' ? 'node' : 'web');
