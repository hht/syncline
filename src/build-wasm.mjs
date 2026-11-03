import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Builds the Rust device-side wasm target into the Rust workspace target directory:
 * - node: for tests (Vitest globalSetup, run once per session; enables testing feature: fault injection, feed pull results and messages),
 *   loaded via {@link rustStorage};
 * - web: for Syncline's dedicated Worker (compiled by {@link withSyncline} on Metro startup; optimized for size), bundled by Metro as
 *   source and assets. Cargo builds incrementally in a few seconds when unchanged.
 * Uses rustup's cargo proxy with an empty RUSTUP_TOOLCHAIN to respect the workspace toolchain configuration.
 * Building SQLite for wasm requires clang targeting wasm, which Apple clang lacks: uses mise-installed LLVM (pinned below).
 * Kept out of the repository mise config so its clang and lldb do not shadow Xcode.
 * Runs cargo within the Rust workspace so SQLite compile flags are discovered.
 * @see https://rust-lang.github.io/rustup/overrides.html
 * @see https://github.com/Spxg/sqlite-wasm-rs/blob/76b199a85ccc5cc440b44318ede300fd90a794c8/README.md
 * @see https://docs.rs/cc/1/cc/#external-configuration-via-environment-variables
 * @see https://wasm-bindgen.github.io/wasm-bindgen/reference/deployment.html
 */

const llvm = 'github:llvm/llvm-project@llvmorg-23.1.4';
const workspace = resolve(import.meta.dirname, '../rust');
export const wasmOutput = join(workspace, 'target/node');

export const wasmTarget = 'wasm32-unknown-unknown';

/**
 * Returns environment variables for compiling wasm targets including SQLite: wasm-targeted clang and llvm-ar.
 * @returns {Record<string, string>}
 */
export function wasmCompilers() {
  let clang;
  try {
    clang = join(execFileSync('mise', ['where', llvm], { encoding: 'utf8' }).trim(), 'bin');
  } catch (error) {
    throw new Error(`Compiling SQLite for wasm requires LLVM: run mise install ${llvm}`, { cause: error });
  }
  const suffix = wasmTarget.replaceAll('-', '_');
  return { [`CC_${suffix}`]: join(clang, 'clang'), [`AR_${suffix}`]: join(clang, 'llvm-ar') };
}

/**
 * Builds wasm for the specified output target: node for tests, web for Syncline's dedicated Worker.
 * @param {'node' | 'web'} output
 */
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
    // Preserve function names in tests for readable panic stack traces; omit for web builds.
    ...(testing ? [] : ['--remove-name-section']),
    '--out-dir',
    outDir,
    join(workspace, `target/${wasmTarget}/${profile}/syncline_wasm.wasm`),
  ]);
  // The node target is CommonJS while this package is an ES module; mark the output directory.
  if (testing) writeFileSync(join(outDir, 'package.json'), '{ "type": "commonjs" }\n');
}

/** Vitest global setup hook that builds node wasm before tests run. */
export default () => buildWasm('node');

// Executed directly by withSyncline for web builds, or with node argument for tests.
// Integrators execute it from dependencies where Node does not strip TypeScript types, so this script is plain JavaScript.
if (import.meta.main) buildWasm(process.argv[2] === 'node' ? 'node' : 'web');
