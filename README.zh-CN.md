<!-- Translated from README.md; update both in the same commit. -->

# Syncline

[English](README.md) | 简体中文

为 Expo 应用提供离线优先的 SQLite 同步，云端运行在 Cloudflare 上。

应用直接读写本地 SQLite 数据库，Syncline 在后台与云端保持同步。离线时照常可用，联网后自动追上。

> [!WARNING]
> Syncline 仍处于预发布阶段。尚未发布到 npm，不兼容的改动可能随时出现，且不提供迁移。

## 特性

- **本地优先**：读写都不等网络。
- **原生 Drizzle**：用 Drizzle 声明一次表，设备端和云端共用。
- **实时查询**：查询读取的表一变化，查询就自动重跑。
- **不丢写入**：断网、重试、崩溃都不会丢失写入，也不会重复执行。
- **iOS、Android、Web**：所有平台同一套 API。
- **运行成本低**：每个用户一个 Durable Object，空闲连接不按时长计费。
- **共享数据**：云端为多个用户写入的数据通过 CDN 下载，每台设备只下载其 token 允许的部分。

## 快速上手

### 1. 安装

从 GitHub 安装最新发布的版本：

```sh
pnpm add github:hht/syncline
```

在末尾加上 `#v<version>` 可以固定到某个[版本](https://github.com/hht/syncline/releases)。

Syncline 的 `postinstall` 脚本只用于它自身的开发。不做决定 pnpm 会拒绝安装，所以在 `pnpm-workspace.yaml` 里关掉它：

```yaml
allowBuilds:
  syncline: false
```

使用 Jest 时，把 `syncline` 加进 `transformIgnorePatterns`：这个包发布的是 TypeScript 源码。

应用还需要 `expo`、`react`、`@tanstack/react-query` 和 `drizzle-orm` 1.0.0-rc.4。然后包装 Metro 配置：

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withSyncline } = require('syncline/metro');

module.exports = withSyncline(getDefaultConfig(__dirname));
```

<details>
<summary>构建依赖</summary>

- Node.js 26 或更高版本。
- iOS 和 Android 需要[开发构建](https://docs.expo.dev/develop/development-builds/introduction/)，不支持 Expo Go。
- 第一次构建 iOS、Android 和第一次启动 Metro 时，会从 Syncline 的 GitHub Release 下载预编译好的二进制，需要能访问 `github.com` 和 `release-assets.githubusercontent.com`。使用代理时，设置 `NODE_USE_ENV_PROXY=1`，让 Node 读取 `HTTPS_PROXY`。

</details>

### 2. 声明表

应用和云端共用一份 schema：

```ts
// schema.ts
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const note = sqliteTable('note', {
  id: text().primaryKey(),
  body: text().notNull(),
});

export const schema = { note };
```

### 3. 配置云端

创建一个存放用户数据的 Durable Object 类，再写一个校验 token 的 Worker：

```ts
// worker.ts
import { forward, SynclineSpace } from 'syncline/cloudflare';
import { schema } from './schema';

export class UserSpace extends SynclineSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, schema);
  }
}

export default {
  // Return { space: userID, expiresAt } (epoch milliseconds), or undefined to reject the token.
  fetch: (request: Request, env: Env) =>
    forward(request, env.USER_SPACE, async (token) => verifyToken(token)),
};
```

在 `wrangler.jsonc` 中注册这个类：

```jsonc
{
  "name": "my-sync",
  "main": "worker.ts",
  "compatibility_date": "2026-09-30",
  "durable_objects": { "bindings": [{ "name": "USER_SPACE", "class_name": "UserSpace" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["UserSpace"] }]
}
```

本地试用运行 `npx wrangler dev`，部署运行 `npx wrangler deploy`。

### 4. 在应用中使用

```tsx
import { randomUUID } from 'expo-crypto';
import { openSyncline } from 'syncline/expo';
import { SynclineProvider, useQuery, useSyncline } from 'syncline/react';
import { schema, note } from './schema';

const space = openSyncline({
  name: 'app',
  userID,
  schema,
  url: 'https://api.example.com/sync',
  token: getIdToken,
});

export function App() {
  return (
    <SynclineProvider value={space}>
      <Notes />
    </SynclineProvider>
  );
}

function Notes() {
  const { data } = useQuery((db) => db.select().from(note));
  const { write } = useSyncline();
  const add = () => write(async (tx) => tx.insert(note).values({ id: randomUUID(), body: 'Hello' }));
  // Render data and call add()
}
```

示例用 `expo-crypto` 生成 ID，任何唯一的字符串都可以。

`SynclineProvider` 必须放在 TanStack Query 的 `QueryClientProvider` 里面。

连接 `wrangler dev` 时，加上 `allowCleartext: true`，地址按设备选：

- iOS 模拟器或浏览器：`http://localhost:8787`
- Android 模拟器：`http://10.0.2.2:8787`
- 手机：先用 `npx wrangler dev --ip 0.0.0.0` 启动，再用电脑的局域网地址

在两台设备上打开应用，在一台上添加一条笔记，另一台上就会出现。

## 文档

- [限制](docs/reference/zh-CN/limits.md)：Syncline 不支持什么，超出每项限制会发生什么。设计 schema 前请先读。
- [常见问题](docs/reference/zh-CN/faq.md)：常见问题和报错。
- [API](docs/reference/api.md)（英文）：所有导出和选项。
