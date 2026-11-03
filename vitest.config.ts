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
    projects: [
      {
        test: {
          name: 'fast',
          include: ['{src,tools}/**/*.test.ts'],
          // Compiles Rust device side to wasm for tests.
          globalSetup: ['src/build-wasm.mjs'],
          // Cloud tests run in the Workers runtime (vitest.workerd.config.ts).
          exclude: ['**/node_modules/**', 'src/**/*.workerd.test.ts'],
        },
      },
      'vitest.workerd.config.ts',
    ],
  },
});
