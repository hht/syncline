import { configDefaults, defineConfig } from 'vitest/config';

/**
 * git 钩子会导出 GIT_DIR 等变量（链接工作树里是绝对路径），测试在临时目录建的仓库会被它指回宿主仓库：
 * git init 把宿主的共享配置写成 core.bare = true，提交写进宿主的 HEAD 并再次触发钩子。测试只操作自己建的仓库，统统清掉
 * @see https://git-scm.com/docs/githooks#_description
 */
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];

export default defineConfig({
  test: {
    /**
     * --changed 只按模块图找受影响的测试，设备一侧的测试经编成 wasm 的 Rust 跑、图里没有 Rust 的源码：只改了 Rust 时一条也不跑。
     * 改了编进测试的 wasm 的 Rust（核心、wasm 外壳、依赖与工具链、编 SQLite 的开关）就整套重跑；构建产物 target 不算（`**` 不进以点开头的目录，.cargo 单列）
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
          // 设备一侧（Rust）编成 wasm 给测试用
          globalSetup: ['src/build-wasm.mjs'],
          // 云端的测试跑在 Workers 运行时里（vitest.workerd.config.ts）
          exclude: ['**/node_modules/**', 'src/**/*.workerd.test.ts'],
        },
      },
      'vitest.workerd.config.ts',
    ],
  },
});
