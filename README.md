# Syncline

在 Expo 设备（iOS、Android、web）与 Cloudflare 之间同步 SQLite 关系表。读写都在设备的本机库上，不等网络；云端是唯一的事实源。

- **本机优先**：界面读写本机 SQLite，离线照常用，联网后自动上传、下载。
- **普通的 Drizzle**：表用 Drizzle 定义，查询照常写；数据变了时，读到这些表的查询自动刷新。
- **每个用户一个 Durable Object**：云端用 DO 的 SQLite，连接可休眠，没有消息时不计时长。
- **共用数据走 CDN**：所有人共用的数据（目录这类）按订阅（一组桶）下载，订阅相同的设备共用一份缓存，百万台设备只让中心算一次。
- **出错不丢**：云端执行不了的写原样扣下、可以修好后重新提交；网络丢失、重复、乱序、崩溃都不会让写丢失或执行两次。协议写成 TLA+ 模型，由 TLC 穷举检查。

## 它怎么工作

本机写马上生效并记进待上传；云端按顺序执行、每次记一版，再把改动和确认推回每台在线设备。设备收到时先撤回没确认的写，应用云端的改动，再把没确认的重放在上面，所以界面看到的永远是「云端的数据，加上我还没被确认的写」。

## 装

还没发布到包仓库，用本地目录引用（pnpm 把它复制进 `node_modules`，依赖与 peer 按 App 解析；改了 Syncline 之后在 App 里重新 `pnpm install`）：

```json
{ "dependencies": { "syncline": "file:../syncline" } }
```

入口是 TypeScript 源码：Metro 与 wrangler 照常打包；jest 要把 `syncline` 加进 `transformIgnorePatterns` 的放行名单。它的 `postinstall` 只给自己开发用，接入方在 `pnpm-workspace.yaml` 的 `allowBuilds` 里设 `syncline: false`。

App 还要有 `expo`、`react`、`@tanstack/react-query`，Metro 配置用 `withSyncline` 包一层：

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withSyncline } = require('syncline/metro');
module.exports = withSyncline(getDefaultConfig(__dirname));
```

设备一侧是 Rust（iOS、Android 是原生模块，要 development build；web 是 wasm），构建时编：要装 rustup（版本照 `rust/rust-toolchain.toml`）；Metro 起来时就编 web 的 wasm（只跑手机也编），要 mise 装的 LLVM（版本见 `src/build-wasm.mjs`，没装时报出安装命令）与 wasm-bindgen CLI（版本与 `rust/Cargo.toml` 里的 `wasm-bindgen` 相同）；Android 另要 cargo-ndk。云端是 Cloudflare Workers，DO 用 SQLite 存储。

## 一眼看完

同一份 Drizzle 表，云端与设备都照它建表：

```ts
export const schema = { workout: sqliteTable('workout', { id: text().primaryKey(), title: text().notNull() }) };
```

云端：继承 `SynclineSpace`，入口 Worker 验 token 后转过去。

```ts
import { forward, SynclineSpace } from 'syncline/cloudflare';

export class UserSpace extends SynclineSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, schema);
  }
}

export default {
  fetch: (request: Request, env: Env) => forward(request, env.USER_SPACE, async (token) => lookUp(token)), // → { space: 用户 id, expiresAt }
};
```

App：打开库，交给 React，用 hooks 读写。

```tsx
import { openSyncline } from 'syncline/expo';
import { SynclineProvider, useQuery, useSyncline } from 'syncline/react';

const space = openSyncline({ name: 'app', owner: uid, schema, url: 'https://api.example.com/sync', token: getIdToken });

<SynclineProvider value={space}>…</SynclineProvider>;

function Workouts() {
  const { data } = useQuery((db) => db.select().from(workout)); // 读到的表变了就自动刷新
  const { write } = useSyncline();
  const add = () => write(async (tx) => tx.insert(workout).values({ id: crypto.randomUUID(), title: '腿日' }));
  // …
}
```

## 还能做什么

| 功能 | 一句话 |
|---|---|
| live query | `useQuery` 读到的表变了就重跑，基于 TanStack Query |
| 外键与校验 | 删父行连带删子行，写完整行校验，两端同一套规则 |
| 本机专用的表 | 不同步的表建在同一个库里，能和同步表一起写、一起查 |
| 服务端的写 | 云端自己改用户的数据，在线设备马上收到 |
| 只由云端写的表 | 付费、试用这类设备只读的数据，设备改不了，改过的客户端推来的也被扣下 |
| 同步状态 | 连着没有、下载进度、待上传几条；手动同步、清空重下 |
| 扣下的写 | 云端执行不了的写原样存着，提示用户，修好后重新提交 |
| 改表 | 照 Drizzle 表自动建表、补列；先发云端再发 App，没升级的 App 照常同步；App 升级不重新下载，部署加表、加列只重下那张表 |
| 共用空间 | 所有人共用、只由后台写的数据，经 CDN 下载、经分片实时推 |
| web | 同一套 API，本机库在 OPFS，同步放在 Syncline 自带的专用 Worker 里 |
| 导出 | 把每个用户的改动交给你，汇总成跨用户统计 |
| 时间点恢复 | 把一个用户的数据恢复到 30 天内的某一刻 |
| 监控 | 云端事件交给你的日志与告警 |

## 文档

参考：[接口](docs/reference/api.md)、[限制](docs/reference/limits.md)。协议怎么验证：[模型与检查](docs/internals/model.md)；设计上的取舍：[取舍记录](docs/internals/adr.md)。
