import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

/**
 * Builds the Rust device-side wasm target into the Rust workspace target directory:
 * - node: for tests (Vitest globalSetup, run once per session; enables testing feature: fault injection, feed pull results and messages),
 *   loaded via {@link rustStorage};
 * - coverage: the node build instrumented for coverage (built by the full check, which runs the tests on it), in its own target directory
 *   so the instrumentation flags do not rebuild the other builds;
 * - web: for Syncline's dedicated Worker (compiled by {@link withSyncline} on Metro startup; optimized for size), bundled by Metro as
 *   source and assets. Cargo builds incrementally in a few seconds when unchanged.
 * Uses rustup's cargo proxy with an empty RUSTUP_TOOLCHAIN to respect the workspace toolchain configuration.
 * Building SQLite for wasm requires clang targeting wasm, which Apple clang lacks: uses mise-installed LLVM (pinned below).
 * Kept out of the repository mise config so its clang and lldb do not shadow Xcode.
 * Runs cargo within the Rust workspace so SQLite compile flags are discovered.
 * Compiles the SQLite sources native links (bundled with libsqlite3-sys) instead of sqlite-wasm-rs's own, so both platforms run the same
 * SQLite version, pinned by the lockfile.
 * @see https://rust-lang.github.io/rustup/overrides.html
 * @see https://github.com/Spxg/sqlite-wasm-rs/blob/76b199a85ccc5cc440b44318ede300fd90a794c8/README.md
 * @see https://docs.rs/crate/sqlite-wasm-rs/0.6.2/source/README.md (Use custom SQLite sources and flags)
 * @see https://docs.rs/cc/1/cc/#external-configuration-via-environment-variables
 * @see https://wasm-bindgen.github.io/wasm-bindgen/reference/deployment.html
 */

const llvm = 'github:llvm/llvm-project@llvmorg-23.1.4';
const workspace = resolve(import.meta.dirname, '..');
const cargoBin = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin');
export const wasmOutput = join(workspace, 'target/node');
/** Target directory and node output of the coverage build. */
export const coverageTarget = join(workspace, 'target/coverage');
export const coverageOutput = join(coverageTarget, 'node');

export const wasmTarget = 'wasm32-unknown-unknown';

/**
 * Returns the bin directory of the pinned LLVM, which also reads the coverage the wasm records (its major version matches rustc's).
 * @returns {string}
 */
export function llvmBin() {
  try {
    return join(execFileSync('mise', ['where', llvm], { encoding: 'utf8' }).trim(), 'bin');
  } catch (error) {
    throw new Error(`Compiling SQLite for wasm requires LLVM: run mise install ${llvm}`, { cause: error });
  }
}

/**
 * Returns environment variables for compiling wasm targets including SQLite: wasm-targeted clang and llvm-ar, and the SQLite sources native
 * links.
 * @returns {Record<string, string>}
 */
export function wasmCompilers() {
  const bin = llvmBin();
  const suffix = wasmTarget.replaceAll('-', '_');
  const metadata = execFileSync(join(cargoBin, 'cargo'), ['metadata', '--format-version', '1', '--locked'], {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, RUSTUP_TOOLCHAIN: '' },
  });
  const found = JSON.parse(metadata).packages.filter((/** @type {{ name: string }} */ crate) => crate.name === 'libsqlite3-sys');
  if (found.length !== 1)
    throw new Error(`Expected one libsqlite3-sys in rust/Cargo.lock to take SQLite sources from, found ${found.length}`);
  const [native] = found;
  return {
    [`CC_${suffix}`]: join(bin, 'clang'),
    [`AR_${suffix}`]: join(bin, 'llvm-ar'),
    SQLITE_WASM_RS_SOURCE_DIR: join(dirname(native.manifest_path), 'sqlite3'),
  };
}

/**
 * Returns PATH with the pinned LLVM first, for wasm builds with the coverage feature: minicov's build script runs `clang` by name.
 * @see https://docs.rs/crate/minicov/0.3.9/source/build.rs
 * @returns {string}
 */
export function clangFirst() {
  return `${llvmBin()}${delimiter}${process.env.PATH}`;
}

/**
 * Instruments the coverage build: wasm has no LLVM profiler runtime, so minicov supplies it, and -Zno-profiler-runtime (unstable, enabled by
 * RUSTC_BOOTSTRAP on the pinned stable toolchain) keeps rustc from linking one.
 * llvm-cov cannot read the function names out of linked wasm, so the build also emits LLVM IR for the coverage gate to compile.
 * @see https://github.com/Amanieu/minicov/blob/v0.3.9/README.md
 * @see https://wasm-bindgen.github.io/wasm-bindgen/wasm-bindgen-test/coverage.html
 * @see https://doc.rust-lang.org/1.99.1/rustc/instrument-coverage.html
 * @returns {Record<string, string>}
 */
function coverageFlags() {
  return {
    RUSTC_BOOTSTRAP: '1',
    PATH: clangFirst(),
    [`CARGO_TARGET_${wasmTarget.replaceAll('-', '_').toUpperCase()}_RUSTFLAGS`]:
      '-Cinstrument-coverage -Zcoverage-options=branch -Zno-profiler-runtime --emit=llvm-ir',
  };
}

/**
 * Builds wasm for the specified output target: node for tests, coverage for tests that record coverage, web for Syncline's dedicated Worker.
 * @param {'node' | 'coverage' | 'web'} output
 */
export function buildWasm(output) {
  const covered = output === 'coverage';
  const testing = output !== 'web';
  const profile = testing ? 'wasm-test' : 'web';
  const target = covered ? coverageTarget : join(workspace, 'target');
  execFileSync(
    join(cargoBin, 'cargo'),
    [
      'build',
      '--locked',
      '--profile',
      profile,
      '-p',
      'syncline-wasm',
      ...(testing ? ['--features', covered ? 'coverage' : 'testing'] : []),
      '--target',
      wasmTarget,
      '--target-dir',
      target,
    ],
    {
      cwd: workspace,
      stdio: 'inherit',
      env: { ...process.env, RUSTUP_TOOLCHAIN: '', ...wasmCompilers(), ...(covered ? coverageFlags() : {}) },
    },
  );
  const outDir = covered ? coverageOutput : join(workspace, 'target', output);
  execFileSync(join(cargoBin, 'wasm-bindgen'), [
    '--target',
    testing ? 'nodejs' : 'web',
    // Preserve function names in tests for readable panic stack traces; omit for web builds.
    ...(testing ? [] : ['--remove-name-section']),
    '--out-dir',
    outDir,
    join(target, `${wasmTarget}/${profile}/syncline_wasm.wasm`),
  ]);
  // The node target is CommonJS while this package is an ES module; mark the output directory.
  if (testing) writeFileSync(join(outDir, 'package.json'), '{ "type": "commonjs" }\n');
}

/** Vitest global setup hook that builds node wasm before tests run. */
export default () => buildWasm('node');

// Executed directly by withSyncline for web builds in a checkout of this repository, or with node or coverage argument for tests.
if (import.meta.main) buildWasm(process.argv[2] === 'node' || process.argv[2] === 'coverage' ? process.argv[2] : 'web');
