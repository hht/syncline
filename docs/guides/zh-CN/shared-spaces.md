<!-- Translated from docs/guides/shared-spaces.md; update both in the same commit. -->

# 共享空间

[English](../shared-spaces.md) | 简体中文

共享空间存放云端为多个用户写入的数据。每台设备只下载其 token 允许的行。设备只读共享空间，只有云端能写入。

本指南从零搭建一个共享空间。代码取自[示例 Worker](../../../examples/cloudflare)，它能在 `wrangler dev` 下运行，并带有测试。

## 各部分如何配合

共享空间在 Worker 里需要四个部分：

| 部分 | 作用 |
|---|---|
| `SynclineSharedSpace` | 存放数据的 Durable Object。服务端写入都写到这里。 |
| `SynclineBroadcast` | 承载设备实时连接的 Durable Object。共享空间默认把连接分散到 128 个这样的对象上（`shards`）。 |
| `SynclineSharedEntry` | 响应下载请求的 Worker 入口。Workers Cache 位于它前面。 |
| `forwardShared` | 在 Worker 的 `fetch` 里调用。先检查 token，再把实时连接转给广播对象、把下载转给入口。 |

## 1. 定义空间

把桶规则放在单独的模块里，由 Worker 和共享空间 Durable Object 共同引用。表放在另一个模块里，应用也引用它。

```ts
export const shared = {
  schema: { document, revision, section },
  rules: {
    public: {
      document: { where: "status = 'published'" },
      revision: { where: "status = 'published'" },
      section: { where: "status = 'published'" },
    },
    admin: { document: {}, revision: {}, section: {} },
    team: { document: { by: ['team_id'] } },
    level: { document: { by: ['level'] } },
  },
} satisfies SharedDefinition;
```

- `schema` 列出设备会收到的表。
- `rules` 把规则名映射到它覆盖的表。一行满足 `where`、且 `by` 中的列都不为 null 时，属于桶 `[规则名, ...by 列的值]`。
- `where` 只能读取本行自己的列。这对关联表意味着什么，见[桶规则](bucket-rules.md)。

## 2. 把用户映射到桶

一个 token 授予一组桶。写一个函数计算它：

```ts
/** Buckets a user may read: text columns take strings, integer columns take numbers. */
export function bucketsOf(user: User): Bucket[] {
  return [
    ['public'],
    ...(user.admin ? [['admin'] as Bucket] : []),
    ...user.teams.map((team): Bucket => ['team', team]),
    ['level', user.level],
  ];
}
```

参数类型必须与列的类型完全一致：文本列传字符串，整数列传数字。`['level', '2']` 不匹配整数列：`forwardShared` 会抛错，而不是悄悄地什么都不显示。

实数和其他类型的列不能作为桶列。

## 3. 编写三个类

```ts
export class SharedSpace extends SynclineSharedSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { ...shared, cloud, broadcast: (bindings) => bindings.SHARED_BROADCAST });
  }
```

`SynclineSharedSpace` 接收定义，外加：

- `broadcast`：一个从 `env` 返回广播命名空间的函数。共享空间通过它把每次改动发给所有广播对象。
- `cloud`、`validation`、`retired`、`onEvent`：可选，与 `SynclineSpace` 相同。见 [API](../../reference/api.md#shared-spaces)（英文）。

再添加你自己的方法，在其中调用 `this.mutate`。这是写入的唯一途径。

```ts
export class SharedBroadcast extends SynclineBroadcast<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, env.SHARED_SPACE);
  }
}
```

`SynclineBroadcast` 接收共享空间的命名空间。广播对象的名字是 `<空间名>#<n>`，它按最后一个 `#` 之前的部分找到所属的共享空间。

```ts
export class SharedEntry extends SynclineSharedEntry<Env> {
  protected shared() {
    return this.env.SHARED_SPACE;
  }
}
```

`SynclineSharedEntry` 只需实现 `shared()`，返回共享空间的命名空间。

## 4. 在 Worker 中路由请求

```ts
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/shared') {
      const route = { entry: ctx.exports.SharedEntry, broadcast: env.SHARED_BROADCAST, space: 'shared', definition: shared };
      return forwardShared(request, route, async (token) => {
        const user = await verifyToken(token, env.TOKEN_SECRET);
        return user && { buckets: bucketsOf(user), expiresAt: user.expiresAt };
      });
    }
    if (pathname === '/sync')
      return forward(request, env.USER_SPACE, async (token) => {
        const user = await verifyToken(token, env.TOKEN_SECRET);
        return user && { space: user.id, expiresAt: user.expiresAt };
      });
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

`verifyToken` 代表你自己的 token 校验。返回 `undefined` 时响应 401。

`route` 的各字段：

- **`entry`**：传入 `ctx.exports.SharedEntry` 本身，不要传 `ctx.exports.SharedEntry.fetch`。Syncline 调用它时把订阅作为 props 传入，而调用 `.fetch(request, { props })` 会丢失 props，入口随即抛出 `SynclineSharedEntry received no props`。
- **`broadcast`**：广播命名空间。
- **`space`**：共享空间 Durable Object 的名字。使用固定的名字。服务端写入必须到达同一个名字：`env.SHARED_SPACE.getByName('shared')`。名字不同就是不同的空间。
- **`definition`**：构建共享空间时用的同一个对象。

空间名加上 `#127`（默认分片数时）必须在 1,024 字节以内。只能按名字访问空间（`getByName` 或 `idFromName`）。用 `newUniqueId` 或 `idFromString` 得到的 ID 会让它抛错。

私有空间和共享空间共用一个 Worker，按路径路由，如上所示。

## 5. 配置 wrangler

```jsonc
  "durable_objects": {
    "bindings": [
      { "name": "USER_SPACE", "class_name": "UserSpace" },
      { "name": "SHARED_SPACE", "class_name": "SharedSpace" },
      { "name": "SHARED_BROADCAST", "class_name": "SharedBroadcast" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["UserSpace", "SharedSpace", "SharedBroadcast"] }],
```

所有类都用 `new_sqlite_classes` 创建。`SynclineBroadcast` 只保存它的闹钟和连接，不存其他数据，但 Cloudflare [建议](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)所有新类都用 SQLite 存储，而且免费套餐只提供 SQLite。

然后为入口开启 Workers Cache，且只为入口开启：

```jsonc
  "cache": { "enabled": true },
  "exports": {
    "default": { "type": "worker", "cache": { "enabled": false } },
    "SharedEntry": { "type": "worker", "cache": { "enabled": true } }
  }
```

一旦开启，Workers Cache 会位于每个入口前面，包括默认入口。见 [Cloudflare 的示例](https://developers.cloudflare.com/workers/cache/examples/)。

| 如果漏掉 | 会发生什么 |
|---|---|
| `cache` | 什么都不缓存。每次下载都打到共享空间 Durable Object，并按此计费。 |
| `"default"` 的 `enabled: false` | 每个发往 Worker 的请求都先查缓存。`forwardShared` 把自己的响应标为 `no-store`，所以不会被缓存；但你的其他路由只要返回 200 且没有 `Cache-Control`，就会被缓存 2 小时，之后直接返回缓存而不执行你的代码。 |

Workers Cache 需要 Wrangler 4.69.0 或更高版本；按入口配置的 `exports` 需要 4.107.0 或更高版本（[配置](https://developers.cloudflare.com/workers/cache/configuration/)）。

## 6. 在应用中打开空间

从不含云端代码的模块把共享表引入应用。示例把它们放在 [`examples/cloudflare/tables.ts`](../../../examples/cloudflare/tables.ts)，与规则分开。

```ts
  const shared = syncline.openShared('shared', {
    schema: { document, revision, section },
    url: 'https://api.example.com/shared',
    userID,
  });
```

- **`name`**（第一个参数）：这个空间在本地的名字。每个共享空间各用一个。
- **`url`**：路由到 `forwardShared` 的路径。
- **`token`**：可选。省略时沿用私有空间的 `token`。
- **`userID`**：当前登录的用户。与上次不同时，设备会在之后的任何查询执行前，清除上一个用户看到的行。省略时，打开空间不会清除任何数据。

像查询其他表一样，通过 `syncline.db` 查询共享表。

### 权限变化时

用户的访问权限变化时，对共享空间调用 `reconnect()`，例如在 Firebase 的 `onIdTokenChanged` 里。每个空间各自重连：`syncline.reconnect()` 只重连私有空间。

```ts
  onTokenChanged(() => {
    syncline.reconnect();
    shared.reconnect();
  });
```

下载每次都会检查 token。实时连接在重连前一直沿用旧的桶。不调用 `reconnect()` 时，实时更新按旧权限过滤，直到旧 token 过期后最多一分钟。

给订阅增加桶只下载新增的桶。去掉桶会重新下载全部数据；在下载完成前，旧的行仍然可见。

## 7. 本地开发

- 给 `openSyncline` 传入 `allowCleartext: true`。它对共享空间同样生效。
- 地址与 [README](../../../README.zh-CN.md#4-在应用中使用) 中相同。
- 在 `wrangler dev`（4.158.0）和 Vitest（`@cloudflare/vitest-plugin` 1.6.0）中，Workers Cache 不会响应请求。每次下载都打到 Durable Object，所以本地运行看不到缓存效果。部署之后，由缓存返回的下载，响应头 `cf-cache-status` 为 `HIT`。

## 下一步

- [桶规则](bucket-rules.md)：建模谁能看到什么。
- [批量写入](bulk-writes.md)：导入大量数据。
- [测试](testing.md)：用 Vitest 测试云端。
