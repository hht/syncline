import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Git hooks export variables like GIT_DIR (absolute paths in linked worktrees), pointing test repositories back to the host:
 * git init marks host shared config as core.bare = true, commits write to host HEAD and re-trigger hooks. Clean them up so tests touch only
 * their own repositories.
 * @see https://git-scm.com/docs/githooks#_description
 */
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];

export default defineConfig({
  test: {
    /**
     * --changed resolves affected tests solely from module graphs, omitting Rust sources since device-side tests run via compiled wasm.
     * Reruns all tests when Rust code compiled into test wasm changes (core, wasm wrapper, dependencies, toolchains, SQLite flags).
     * Ignores target artifacts.
     * @see https://vitest.dev/config/forcereruntriggers
     */
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/rust/{core,wasm}/**',
      '**/rust/{Cargo.toml,Cargo.lock,rust-toolchain.toml}',
      '**/rust/.cargo/**',
    ],
    // Enabled by the full check (--coverage); both projects report into one map, read with the Rust coverage by tools/check/coverage.ts.
    // Workers tests run only under istanbul, which instruments source rather than relying on V8.
    // @see https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#coverage
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      reporter: ['lcovonly'],
      reportsDirectory: '.check/coverage',
    },
    projects: [
      {
        test: {
          name: 'fast',
          // Gates run tests beside other CPU-bound gates, stretching second-long tests many times over under high machine load; the timeouts
          // only have to catch hangs.
          testTimeout: 60_000,
          hookTimeout: 60_000,
          include: ['{test,tools}/**/*.test.ts'],
          // Compiles Rust device side to wasm for tests.
          globalSetup: ['rust/wasm/build.mjs'],
          setupFiles: process.env.SYNCLINE_COVERAGE === undefined ? [] : ['test/support/rust-coverage.ts'],
          // Cloud tests run in the Workers runtime (vitest.workerd.config.ts).
          exclude: ['**/node_modules/**', 'test/**/*.workerd.test.ts'],
        },
      },
      'vitest.workerd.config.ts',
      // The example Worker the integration guides quote, with its own wrangler.jsonc.
      'examples/cloudflare/vitest.config.ts',
    ],
  },
});
