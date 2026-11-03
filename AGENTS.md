# AGENTS.md — Syncline

> 本轮用户输入优先于任何文档。

## 这是什么

在 Expo 设备（iOS、Android、web）与 Cloudflare 之间同步 SQLite 关系表的库，独立产品：只看它自己的需求与 Cloudflare 的平台上限，不按某个接入方的现状定取舍；代码、注释与文档里不提接入方的项目。用法见 [README](README.md)。

## 最高准则

1. **删除优先。** 每行答得出「删掉会坏什么」，答不出先查来历，查清仍答不出就删；可读性不降。只转发、只换名字的函数、类型、文件内联；不为未出现的需求写代码（测试、重构不算）。
2. **一个模块一个问题。** 按问题划模块：一个问题＝一个会独立变化的设计决定，不按处理步骤切；接口比实现小得多，开头写明答哪个问题、不该知道什么，宁深勿碎。依赖单向无环；计算与副作用分开，核心是可直接测试的纯函数。
3. **算法精妙。** 先想清本质、先定数据结构，规模决定的结构设计时就选对；局部调速先测量。
4. **信任边界。** 网络、存储、接入方传进来的数据在边界解析成精确类型，之后内部直接用。兜底、try/catch、默认值只给真会发生的情况；内部不变量坏了就抛、顶层接住报告。
5. **从根源解决。** 改在产生问题的地方；找不到根因就停下报告。修漏洞先写会失败的测试。
6. **照一手资料。** 设计照搬一个成熟实现或论文的完整做法（PowerSync、ElectricSQL、Replicache 等），只写平台逼出来的偏差；依赖外部系统（Cloudflare、SQLite、Expo、Rust 库）的行为先按实际用的版本读源码或实测，代码里用 `@see` 指向官方文档或带版本标签的源码。

协议的性质只守四条：不卡住、不丢数据、最终同步、费用低。小优化不加复杂逻辑。

## 目录

```
src/            TypeScript：云端（cloud/、cloudflare/）、设备上的 JS 绑定（expo/）、表的声明（tables/）、可插拔的功能（features/）、测试辅助（test/）
rust/           设备一侧：core（本机库与同步的状态机，不做网络与计时）、native（iOS、Android 的线程与网络）、wasm（web 的 Worker）
ios/ android/   Expo 模块的原生外壳，构建时编 rust/native
model/          TLA+ 协议模型与配置
probes/         在真实 Cloudflare 上跑的探针
docs/           reference/ 是给接入方的使用文档；internals/ 是取舍记录与模型说明
tools/          门禁（check/）与模型运行器（dev/）
```

依赖方向由门禁 `depcruise` 守着，规则与理由在 `.dependency-cruiser.json`。

## 文档

| 什么时候 | 读哪份 |
|---|---|
| 开工前、做取舍 | [取舍记录](docs/internals/adr.md) |
| 改协议、改 `model/` | [模型与检查](docs/internals/model.md) |
| 改接入方看得到的行为或数字 | [API](docs/reference/api.md)、[限制](docs/reference/limits.md) |

代码、测试与模型是真源。文档只记用户拍板的决定与读代码看不出的原因；实现细节与试错经过留在代码、测试与提交说明里。改用户拍板过的决定先问用户：给对比表，定了再改取舍记录。给接入方的使用文档（README 与 `docs/reference/`）照用法写，可以有数字（`limits.md` 的数字由测试对着代码核），不写来历。

代码规范里门禁管不到、靠提交前审查的：
- 标识符、文件名、分支名用简单英文。注释、字符串、报错、测试名与文档正从中文改成英文：新写的与改到的整句用英文，没改到的留给统一翻译。
- 命名在调用处读起来清楚再求简短，按角色起名，一个概念一个词（[Swift API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/)）。
- 导出的用 `/** */`：第一句说做什么，再写调用方必须知道的约定；行内 `//` 只写为什么，写成事实。
- 测真实行为，期望值来自独立的来源；经公开接口测，能用真实现就用，其次 fake，mock 只用在两者都接不进的地方。
- 新增依赖须经用户明示。

## 环境

- cargo 一律用 `~/.cargo/bin/cargo`，并带 `RUSTUP_TOOLCHAIN=`（空）；工具链版本照 `rust/rust-toolchain.toml`。
- 编 web 的 wasm 要 mise 装的 LLVM 与 wasm-bindgen CLI（版本见 `src/build-wasm.mjs`，没装时它报出安装命令）；Android 另要 cargo-ndk。
- 机器负载高时几条 5 秒时限的测试会超时：等负载降下来再跑，不为它改测试。

## 命令

唯一的检查入口是 `pnpm check`（本地钩子同一套），全绿才算完成。

- `pnpm check`：门禁分两批并行（编 Rust 的先跑完），只输出 `文件:行 规则 说明`，完整日志在 `.check/<门禁>.log`；`--changed` 只查相对 HEAD 改动与未跟踪的文件（pre-commit 用）。
- `pnpm q <命令>`：只看精简输出，完整日志在 `.q/`。
- `pnpm postinstall`：按 `src/cloudflare/wrangler.jsonc` 重新生成 Workers 的类型，装依赖时自动跑。
- `pnpm model`、`pnpm model:setup`、`pnpm model:big`、`pnpm model:trace`：协议模型的慢门禁，不在 `pnpm check` 里；改了 `model/` 跑 `pnpm model`、全绿才能提交；什么时候跑哪个见 [模型与检查](docs/internals/model.md)「怎么跑」。模型长跑先估时，几十分钟以上的先问用户。

## 提交

- `commit` / `push` 要用户本轮明示；`amend`、`force-push`、改 git 配置不做。
- 提交前对改动逐行做删除优先审查，汇报列出删了什么、改了什么、有争议但保留的行与理由。
- 提交前做**独立审查**：派一个新开的子 agent（不用 fork，不带本会话的上下文；只读）审这次的 diff，给它改动、相关文件与要守的性质，让它找回归、漏洞、与文档和模型不符处，每条带复现或 `文件:行`。只有「必须修」拦提交：数据丢失或错误、永远卡住、安全问题、与模型不符；修完再派一个新开的子 agent 审修过的 diff，至多两轮，第二轮仍有必须修的停下交用户定。不严重的当轮顺手修掉或记进汇报。
- 一个提交只做一件能独立看懂的改动，相关测试放在同一个提交；重构与功能、修复分开。
- 格式照 Conventional Commits，类型只有 `feat` `fix` `change` `refactor` `test` `docs` `deps` `chore`，不带 scope 与 `!`，全文英文：——门禁 `commit-message`

  ```
  <type>: <one-line summary of the change>

  - specific change
  ```

## 汇报

- 先总结，再给建议的下一步。
- 每个结论带依据（源码 `文件:行`、官方文档链接或实测）；推断标「推断 / 未证实」。前提错了直接指出。
- 换会话用 `handoff`，交接写到仓库根的 `HANDOFF.md`（每次覆盖、不提交）；新会话先读它。

## Agent skills

| 意图 | skill | 结论落盘 |
|---|---|---|
| 磨方案、疑点讨论 | `grill-with-docs` | 取舍记录 |
| 查库/协议事实 | `research` | 调研放系统临时目录，用户的取舍写进取舍记录 |
| 按入口实现 | `tdd`（接口词汇见 `codebase-design`） | 代码与测试 |
| 难 bug | `diagnosing-bugs` | 根因写入提交说明 |
| 改 AGENTS.md / skill | `writing-for-agents` | — |
| 换会话接手 | `handoff` | 仓库根 `HANDOFF.md` |
