<!-- Translated from docs/reference/api.md; update both in the same commit. -->

# API

[English](../api.md) | 简体中文

按包入口列出全部导出。

| 入口 | 运行在 | 导出 |
|---|---|---|
| [`syncline/expo`](#synclineexpo) | 应用 | `openSyncline`、`syncOnce` |
| [`syncline/react`](#synclinereact) | 应用 | `SynclineProvider`、`useQuery`、`useSyncline`、`useSyncStatus` |
| [`syncline/expo/background`](#synclineexpobackground) | 应用，iOS 和 Android | `defineBackgroundSync`、`startBackgroundSync`、`stopBackgroundSync` |
| [`syncline/metro`](#synclinemetro) | 你的 Metro 配置 | `withSyncline` |
| [`syncline/cloudflare`](#synclinecloudflare) | 你的 Worker | `SynclineSpace`、`forward`、`restoreSpace`，以及[共享空间](#共享空间)的导出 |

大多数应用只需要应用里的 `openSyncline`、`SynclineProvider`、`useQuery` 和 `useSyncline`，加上云端的 `SynclineSpace` 和 `forward`。从[快速上手](../../../README.zh-CN.md#快速上手)开始，设计表之前先读[限制](limits.md)。

本页代码取自 [`examples/`](../../../examples) 下的示例。

## `syncline/expo`

iOS、Android 和 Web 共用这个入口和它的选项。在 iOS 和 Android 上，数据库和同步运行在原生模块里；在 Web 上，它们运行在 Syncline 自带的 Web Worker 里。

### `openSyncline(options)`

打开本地数据库（首次使用时创建），并开始同步已登录用户的私有空间。

```ts
  const syncline = openSyncline({
    name: 'app',
    userID,
    schema: { note },
    url: 'https://api.example.com/sync',
    token,
  });
  await syncline.waitForReady();
```

它立即返回一个 [`Syncline`](#syncline)，在后台打开数据库。依赖它之前先 await `waitForReady()`。

| 选项 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 数据库名。文件是 `<name>.db`。每个应用用一个数据库。 |
| `userID` | `string` | 已登录用户的 ID，非空字符串。只有一个用户的应用传一个常量。见[切换用户](#切换用户)。 |
| `schema` | `{ tableName: drizzleTable }` | 同步表。打开时创建这些表并添加新列。[表结构](limits.md#表结构)列出表能声明什么。首次声明时已有数据的表，比如从 `localOnly` 移过来的表，会被清空并重新下载：见[表进出同步](limits.md#表进出同步)。 |
| `url` | `string` | 私有空间同步路由的地址：`https://`，不带查询参数或 `#`。设备连接它，也从它下载。 |
| `token` | `() => Promise<string>` | 返回用户的 token。见 [Token](#token)。 |

<details>
<summary>更多选项</summary>

| 选项 | 类型 | 说明 |
|---|---|---|
| `localOnly` | `{ tableName: drizzleTable }` | 只保存在这台设备上、从不同步的表。把表移入或移出这个列表可能清空它的行：见[表进出同步](limits.md#表进出同步)。 |
| `validation` | `Map<drizzleTable, StandardSchema>` | 每张表一个 schema，每次写入都会检查。它必须同步给出结果：返回 Promise 的 schema 会让写入失败。 |
| `readOnly` | `drizzleTable[]` | 只有云端写入的同步表。本地写入这些表会抛错并回滚。每张都必须在 `schema` 中，而且只能引用只读表，否则 `openSyncline` 抛错。在云端传同一个列表。 |
| `retired` | `string[]` | 永久移出同步的表和列（`'table.column'`）。打开时删除已退役的列，以及某个空间上次打开时声明过的已退役的表：见[表进出同步](limits.md#表进出同步)。在云端传同一个列表。已退役的名字永远不能再声明，无论在哪个列表里，还是用于你自己的表：请换个新名字。见[怎么修改表结构？](faq.md#怎么修改表结构) |
| `discardPending` | `boolean` | `userID` 改变时丢弃上一个用户待上传的写入。见[切换用户](#切换用户)。 |
| `allowCleartext` | `boolean` | 私有空间和共享空间接受 `http://` 地址。token 和行以明文传输：只在本地开发时使用，比如连接 `wrangler dev`。 |
| `checksumRowsPerDay` | `number` | 每日[数据校验](limits.md#数据校验)最多校验的行数，默认 1,000,000。云端会读取这些行，读取计费。 |

</details>

- **两种失败方式。** 只看选项就能发现的问题，`openSyncline` 直接抛错：空的 `userID`，或者违反规则的表声明，比如不支持的列类型。只有数据库打开后才显现的问题，比如某列类型被改了，则让 `waitForReady()` 被拒绝。[表结构](limits.md#表结构)写明每条规则以哪种方式失败，[`waitForReady()` 被拒绝](errors.md#waitforready-被拒绝)列出其他原因。
- **iOS 和 Android：每个名字只能打开一个实例。** 打开一个已在前台打开的名字会抛错。先调用 `close()`。
- **Web：每个标签页一个数据库，每个站点一个标签页。** 打开一个数据库会关闭这个标签页已打开的那个，不论名字；之后对已关闭的那个调用会以 `Local database is closed` 失败。第二个标签页[无法打开数据库](errors.md#web-应用只能在一个标签页里用)。

#### 切换用户

以与上次不同的 `userID` 打开，会清除上一个用户的私有数据和仅本地表。共享空间保留。

如果上一个用户仍有写入等待上传，打开会以 [`PendingWritesError`](errors.md#打开数据库时出现-pendingwriteserror) 失败，什么都不清除。所以在用户退出登录之前把它们上传：

```ts
  if (syncline.status().pending > 0) await syncline.sync();
  await syncline.close();
```

完整步骤见[怎么让用户退出登录？](faq.md#怎么让用户退出登录)。

写入永远不会从一个用户转到另一个用户，所以要在用户登录之后再打开数据库。

每个用户有一个私有空间：你的云端 `verify` 为该用户的 token 返回的 `space`。如果云端报告的空间不是这个数据库第一次同步的那个，同步停止，并出现 [`AccountMismatchError`](errors.md#downloaderror-中出现-accountmismatcherror)。

#### Token

Syncline 在每次连接前调用 `token`，连接期间每下载一块数据之前也会调用。如果获取 token 很慢，请缓存它。

- **临近过期时返回新的 token。** 设备会在 token 过期前 1 到 4 分钟之间重新连接并再次调用 `token`。返回时剩余 4 分钟以内的 token [不会提前续期](edge-cases.md#剩余-4-分钟以内的-token-不会提前续期)。
- **失败会重试。** 如果 `token` 抛错、解析为 `undefined` 或 `null`，或者超过 30 秒，就会设置 `downloadError`，设备按退避重试。
- **退出登录时调用 `close()`。** 不要从 `token` 抛错：设备会一直重试。

<details>
<summary>Firebase Authentication</summary>

在 iOS 上，以及 Web 上使用 Firebase JS SDK 13.2.0 或更高版本时，`getIdToken()` 会一直返回缓存的 token，直到离过期不足 5 分钟。更早的 JS SDK 版本只在最后 30 秒内刷新，而 `@react-native-firebase` 27.1.1 在 Web 上用的是 JS SDK 13.1.0。Firebase 没有说明 Android 何时刷新。

要在所有平台上拿到新的 token，在 token 5 分钟内过期时调用 `getIdToken(true)`。

</details>

### `Syncline`

`openSyncline` 返回的对象。

| 成员 | 说明 |
|---|---|
| `name` | 数据库名。 |
| `db` | 用于读取的 Drizzle 数据库。它不能写入：请用 `write`。 |
| [`write(body)`](#writebody) | 在事务中执行一次本地写入。 |
| `onChange(listener)` | 同步表或仅本地表改变后，以这些表的名字（`ReadonlySet<string>`）调用 `listener`。返回一个移除该监听器的函数。 |
| `tablesOf(sql)` | 不执行查询，解析为它读取的表名。 |
| [`waitForReady()`](#waitforready) | 数据库打开后解析。 |
| `status()` | 当前的 [`SyncStatus`](#syncstatus)。 |
| `onStatus(listener)` | 状态每次变化时以它调用 `listener`。返回一个移除该监听器的函数。 |
| [`sync(options?)`](#syncoptions) | 立即同步，等到追上为止。 |
| [`resync(options?)`](#resyncoptions) | 从头重新下载同步表。 |
| `reconnect()` | 立即重新连接并再次调用 `token`。用户凭据变化时调用，比如在 Firebase 的 `onIdTokenChanged` 中。 |
| `onHeld(listener)` | 以云端拒绝执行的写入调用 `listener`：`{ reason, changes }[]`，其中 `reason` 最多 1,000 个字符。返回一个移除该监听器的函数。见[写入出现后又消失了](errors.md#写入出现后又消失了)。 |
| [`openShared(name, options)`](#opensharedname-options) | 在同一个数据库中打开一个只读的共享空间。 |
| `close()` | 停止同步并关闭数据库。 |
| `delete()` | 关闭数据库并删除它的文件，包括尚未上传的写入。 |

#### `waitForReady()`

数据库打开、私有空间开始同步后解析。它不等网络。

它以数据库无法打开的原因被拒绝，`downloadError` 也会显示这个原因。见 [`waitForReady()` 被拒绝](errors.md#waitforready-被拒绝)。

#### `write(body)`

在一个本地事务中运行 `body(tx)`，并解析为 `body` 的返回值。`tx` 是一个可读可写的 Drizzle 数据库。

```ts
  await syncline.write(async (tx) => {
    const [existing] = await tx.select().from(note).where(eq(note.id, id));
    if (!existing) await tx.insert(note).values({ id, body });
  });
```

- **在 `body` 中只 await `tx`。** `body` 结束之前，其他所有读写和来自云端的每个改动都要等待。await 一个 `db` 查询或另一个 `write` 的 `body` 永远不会结束。排在一次写入之后等了 5 秒的操作都会在控制台输出警告，所以让 `body` 保持简短。
- **失败的写入什么都不保存。** 如果 `body` 抛错或写入违反规则，事务回滚，`write` 被拒绝。见[写入抛错](errors.md#写入抛错)。

#### `sync(options?)`

立即同步。设备追上进度、云端确认了每条本地写入后解析；如果已经如此，立即解析。

```ts
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Sync timed out')), timeout);
  await syncline.sync({ signal: controller.signal }).finally(() => clearTimeout(timer));
```

- **`options.signal`** 是一个 `AbortSignal`：中止它会让这次调用以 `signal.reason` 被拒绝。
- **它不等网络。** 离线时，它立即发起一次连接尝试，尝试失败时被拒绝。
- **它以状态中显示的错误被拒绝**，即 `downloadError` 或 `uploadError`。其中只有 `PendingWritesError` 和 `AccountMismatchError` 可以用 `instanceof` 判断。
- **`AccountMismatchError` 让同步停止后**，之后的调用以 `sync has not started` 被拒绝。
- **云端以 [1007](errors.md#uploaderror-显示代码-1007) 拒绝上传之后**，它会立即被拒绝，直到应用重启或调用 `resync()`。

#### `resync(options?)`

从头重新下载同步表，替换本地副本。在本地数据损坏时使用。下载落地之前，原有的行保持可见。

- **`options.signal`** 与 `sync` 中的相同。
- **待上传的写入会保留**，下载之后照常上传。
- **`options.discardPending: true` 会把它们也丢弃。** 在云端一直以 [1007](errors.md#uploaderror-显示代码-1007) 拒绝上传时使用。
- **被丢弃的写入可能已经在云端。** 如果云端执行了它而设备没收到确认，下载会把它的改动带回来。
- **丢弃可能失败。** 如果某条待上传的写入无法撤销，同步表会[改为被清空](edge-cases.md#丢弃待上传的写入可能清空同步表)。

#### `openShared(name, options)`

在同一个数据库中打开一个共享空间。设备只读取共享空间；像查询其他表一样通过 `db` 查询它的表。

```ts
  const shared = syncline.openShared('shared', {
    schema: { document, revision, section },
    url: 'https://api.example.com/shared',
    userID,
  });
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 空间在本地的名字，非空。每个共享空间需要自己的名字。 |
| `options.schema` | `{ tableName: drizzleTable }` | 空间的表。一张表只属于一个空间：私有空间、仅本地表和其他共享空间都不能使用它的名字。 |
| `options.url` | `string` | 你传给 `forwardShared` 的路由的地址，规则与 `openSyncline` 的 `url` 相同。 |
| `options.token` | `() => Promise<string>` | 可选；默认使用私有空间的 `token`。云端根据 token 决定设备能看到哪些行。 |
| `options.userID` | `string` | 可选。已登录的用户。与上次不同时，上一个用户看到的行会在之后的任何查询运行之前被清除。不传时，什么都不清除。 |

它返回一个 `SharedSpace`，有自己的 `name`、`waitForReady`、`status`、`onStatus`、`sync`、`resync` 和 `reconnect`，用法与 `Syncline` 上的相同。共享空间没有待上传的写入，所以它的 `resync` 忽略 `discardPending`。

- **再次调用会返回已打开的空间**，前提是 `name`、`url` 和 `userID` 相同；另传的 `token` 或 `schema` 会被忽略。`url` 或 `userID` 不同会抛错。
- **它会抛错**：`name` 为空时，以及遇到 `openSyncline` 会抛错的声明时。
- **它的 `waitForReady()` 被拒绝**：声明被拒绝（表名已被另一个空间使用，或用了已退役的名字）、数据库打开失败，或 `url` 无效时。
- **它的表在后台创建。** 如果创建失败，比如某列类型被改了，`waitForReady()` 仍会解析。失败显示在该空间的 `downloadError` 中，同时它会重试。
- **每个空间各自重新连接。** `syncline.reconnect()` 只重新连接私有空间。见[权限变化时](../../guides/zh-CN/shared-spaces.md#权限变化时)。
- **很少遇到：** 切换用户会清除这些行，[即使空间随后打开失败](edge-cases.md#切换用户会清空共享空间即使它随后打开失败)；进入或离开空间的表会被[清空](limits.md#表进出同步)。

### `SyncStatus`

`status()` 返回、`onStatus` 传入的值：每次变化都是一个新对象。

| 字段 | 说明 |
|---|---|
| `connected` | 已连接并追上进度、正在接收实时改动时为 `true`。 |
| `connecting` | 已启动但尚未连上时为 `true`：正在获取 token、下载或等待重试。因应用更新而暂停，或被 `AccountMismatchError` 停止时为 `false`。 |
| `downloading` | 下载进行中时为 `true`。 |
| `downloadProgress` | 从一次下载的第二块开始为 `{ downloaded, total }`；其他时候为 `undefined`。 |
| `pending` | 云端尚未确认的本地写入数。 |
| `hasSynced` | 这个空间同步过一次后为 `true`，重启后保持。 |
| `downloadError` | `Error \| undefined`：获取 token、下载、连接或打开失败的原因。下一块数据下载完成或追上进度后清除。 |
| `uploadError` | `Error \| undefined`：云端执行失败或拒绝已上传写入的原因。之后的写入得到确认时清除。 |
| `updateNeeded` | 云端比应用新，或应用使用了云端已退役的表或列时为 `true`。同步暂停，直到应用更新。 |

### `syncOnce(options, settings?)`

仅限 iOS 和 Android。同步私有空间一次：连接、上传待上传的写入、下载到最新版本，然后解析。它用于系统在后台唤醒应用时给出的几十秒。大多数应用使用会调用它的 [`syncline/expo/background`](#synclineexpobackground)。

- **`options`** 与 `openSyncline` 的相同；`discardPending` 被忽略。**`settings.signal`** 中止这一轮。
- **如果这个进程已打开数据库**，它使用那个实例，并保持打开。否则它打开数据库、同步，再关闭，不留下连接。
- **如果用户在此期间打开了应用**，`openSyncline` 会关闭后台实例并打开自己的实例。`syncOnce` 随即解析，不完成这一轮，此后由前台实例同步。
- **它被拒绝**：`signal` 中止时、同步失败时，以及 `openSyncline` 会抛错的情况。上一个用户有待上传的写入时，它以 `PendingWritesError` 被拒绝。它打开的数据库会被关闭。
- **iOS 收回后台时间时可能立即挂起应用**，所以不保证关闭数据库能完成。
- **不同步共享空间。**

### 错误类

导出了三个错误类，所以可以对它们用 `instanceof`。

| 类 | 何时 | 字段 |
|---|---|---|
| `ValidationError` | 写入的行违反了列声明或你的 `validation` schema。见[写入抛错](errors.md#写入抛错)。 | `table`；`issues`，每项含字段的 `path` 和一条 `message` |
| `PendingWritesError` | 上一个用户有待上传的写入时，为另一个用户打开数据库。见[打开数据库时出现 `PendingWritesError`](errors.md#打开数据库时出现-pendingwriteserror)。 | `userID`，上一个用户；`count`，其待上传的写入数 |
| `AccountMismatchError` | 云端报告的空间不是这个数据库第一次同步的那个。同步停止，不上传。见 [`downloadError` 中出现 `AccountMismatchError`](errors.md#downloaderror-中出现-accountmismatcherror)。 | `stored` 和 `cloud`，两个空间 |

### 类型

`Database`（`db` 和 `tx` 的 Drizzle 数据库）、`Schema`、`OpenOptions`（`openSyncline` 的选项）、`Syncline`、`SharedSpace`（`openShared` 的返回值）、`Held`（`onHeld` 传入的数组中的一项）、`SyncStatus`。

## `syncline/react`

在 TanStack Query 的 `QueryClientProvider` 内使用这些。

### `SynclineProvider`

`<SynclineProvider value={syncline}>` 向它下面的组件提供数据库。`value` 可以是 `undefined`，表示用户未登录。

`value` 改变或 provider 卸载时，它会清除上一个数据库的缓存查询。[快速上手](../../../README.zh-CN.md#4-在应用中使用)展示了它在应用中的用法。

### `useQuery(build)`

执行一个 Drizzle 查询，并让结果保持最新。`build(db)` 返回查询；这个 hook 返回 TanStack Query 的 `useQuery` 的返回值。

```ts
function useNotes() {
  return useQuery((db) => db.select().from(note));
}
```

只有它读取的表改变时，查询才会重新执行。SQL 文本或参数改变（比如捕获的变量）就是一个新的查询。

### `useSyncline()`

返回 provider 持有的数据库，用于写入、`sync()` 和共享空间。没有数据库时抛错。

```ts
function useAddNote() {
  const { write } = useSyncline();
  return (id: string, body: string) => write(async (tx) => tx.insert(note).values({ id, body }));
}
```

### `useSyncStatus()`

返回数据库的 [`SyncStatus`](#syncstatus)，并在它改变时重新渲染。

```ts
function useUnsynced() {
  const { pending } = useSyncStatus();
  return pending > 0;
}
```

## `syncline/expo/background`

可选，仅限 iOS 和 Android：让系统在应用不在前台时唤醒它，同步私有空间。

它需要 `expo-background-task` 和 `expo-task-manager`，版本见[运行要求](limits.md#运行要求)。把 `expo-background-task` 加到 `app.json` 的 `plugins` 中。

```ts
  defineBackgroundSync(async () => {
    const user = await session();
    return user && { name: 'app', schema: { note }, url: 'https://api.example.com/sync', ...user };
  });
```

| 导出 | 说明 |
|---|---|
| `defineBackgroundSync(options)` | 定义一次后台运行同步什么。在应用入口模块的顶层调用它。`options` 是一个返回 `openSyncline` 选项或其 Promise 的函数。它返回 `undefined` 时，这次运行什么都不做。 |
| `startBackgroundSync({ minimumInterval }?)` | 请操作系统唤醒应用来同步，间隔至少 `minimumInterval` 分钟。默认值和最小值：15。 |
| `stopBackgroundSync()` | 停止后台运行。 |

每次运行都调用 [`syncOnce`](#synconceoptions-settings)。

## `syncline/metro`

### `withSyncline(config)`

包装你的 Metro 配置（`metro.config.js`），返回修改后的配置，它把 `.wasm` 文件作为资源打包。

Metro 第一次启动时，会下载已安装版本的 Web WebAssembly 二进制文件。这需要能访问 GitHub；下载失败或校验和不匹配时它会抛错。[安装](../../../README.zh-CN.md#1-安装)中给出了这个文件。

## `syncline/cloudflare`

### `SynclineSpace`

私有空间的 Durable Object 类：每个用户一个对象。继承它，并以你的应用使用的 schema 调用 `super(ctx, env, schema, options?)`。对象启动时创建 schema 中的表并添加新列。[快速上手](../../../README.zh-CN.md#3-配置云端)给出了一个完整的类。

| 选项 | 类型 | 说明 |
|---|---|---|
| `cloud` | `{ tableName: drizzleTable }` | 同步表在云端的定义，可以添加只在云端的列，以及只有云端才有的表。见[云端表](#云端表)。 |
| `validation` | `Map<drizzleTable, StandardSchema>` | 与设备上相同。云端用它检查上传的写入和服务端写入。schema 必须同步给出结果。 |
| `readOnly` | `drizzleTable[]` | 只有服务端写入才能改变的同步表。在设备上传同一个列表。见[只读表](#只读表)。 |
| `retired` | `string[]` | 永久移出同步的表和列（`'table.column'`）。在设备上传同一个列表。已退役的名字永远不能再声明。 |
| `onEvent` | `(event: SynclineEvent) => void` | 云端事件发生时调用，用于日志和告警。见[事件](errors.md#事件)。 |

<details>
<summary>更多选项</summary>

| 选项 | 类型 | 说明 |
|---|---|---|
| `writeQuota` | `{ rate, burst }` | 上传的行改动的速率限制：每秒补充 `rate` 行，最多 `burst` 行。不传时不限。见[上传配额](limits.md#上传配额)。 |
| `dailyWrites` | `number` | 每个 UTC 日上传产生的计费行写入上限。第二天恢复上传。不传时不限。见[上传配额](limits.md#上传配额)。 |
| `connections` | `number` | 最大并发连接数，正整数，默认 32。用户设备多时调大。见[连接数](limits.md#连接数)。 |
| `exporters` | `{ name: Exporter }` | 把空间复制到另一个数据库的导出器。见[导出](../../guides/zh-CN/exports.md)。 |
| `exportDelay` | `number` | 一次写入到它被导出之间的毫秒数，默认 60,000。 |
| `exportBudget` | `number` | 一次 alarm 导出的最长时间，单位毫秒，默认 600,000。超时未应答的导出器这次尝试失败，按退避重试。 |

</details>

- **已退役的表在 30 天后删除**，从这张表首次退役时算起，留出撤销失误的时间。已退役的列留在存储中，不再使用。
- **不要覆盖 `alarm()` 或调用 `setAlarm`。** Syncline 管理对象唯一的 alarm，导出和你自己的定时任务共用它。
- **下面的方法是 protected 的。** 从你自己的方法中调用它们；无法通过 RPC 访问。

#### 云端表

- 云端定义要声明同步表的每一列，存储类型、默认值和主键都要相同。否则对象启动时抛错。
- 主键列的顺序就是表声明列的顺序，所以按 schema 中的顺序声明它们。
- 设备永远收不到只在云端的列。只改变只在云端的列的服务端写入，仍会把这一行重新发给设备，所以把经常变化的值放在只有云端才有的表里。
- 只在云端的列使用 `text()`、`integer()`、`real()` 或 `blob()` 类型。[其他声明在已有的表上会失败](edge-cases.md#类型不常见的只在云端的列在已有的表上会失败)。

#### 只读表

- 只读表必须在 schema 中，而且只能引用只读表：从可写表级联的删除会删掉它的行。否则对象启动时抛错。
- 设备写入涉及只读表时会被[暂扣](errors.md#被暂扣的写入)。把这张表声明为只读的应用永远不会推送这样的写入：它的本地写入会抛错。
- 要把已有的表改为只读，先发布不再写入它的应用更新。尚未更新的应用对它的写入会被暂扣。

#### `mutate(write)`

一次服务端写入：在一个事务中同步运行 `write(tx)`。

```ts
  addNote(id: string, body: string) {
    this.mutate((tx) => tx.upsert(note, { id, body }));
  }
```

`tx` 是一个 `Transaction`：`select`，外加按主键的 `insert`、`upsert`、`update` 和 `delete`。违反规则（比如某项[限制](limits.md#大小)）的写入会抛错并回滚。

#### `held(options?)` 和 `resubmit(client, id, changes?)`

`held({ limit?, after? })` 返回云端暂扣的写入：`{ client, id, reason, version, at, changes }[]`。

- `changes` 是设备推送的内容，类型为 `unknown`：有缺陷的设备可能推送不是合法改动的内容。
- 每页默认最多 100 条，改动较大时更少。要取下一页，把最后一条的 `version` 作为 `after` 传入，直到返回空页为止。

`resubmit(client, id, changes?)` 重新执行一条被暂扣的写入。传入 `changes` 替换原有改动，传入 `[]` 丢弃这条写入。以下情况它会抛错：

- 这条写入已不再被暂扣；
- 改动（传入的或原有的）无法读取，比如含有孤立代理项的文本；
- 改动涉及只读表；
- 改动涉及已退役的表或列。上传会丢弃这些值，但重新提交不会：传入不含它们的 `changes`。

[被暂扣的写入](errors.md#被暂扣的写入)描述了完整流程。

#### `schedule(name, at)`、`unschedule(name)` 和 `scheduled`

你自己的定时器。`schedule(name, at)` 让对象最迟在 `at`（epoch 毫秒）调用 `scheduled(name)`，`unschedule(name)` 取消它。通过覆盖 `scheduled` 处理这些调用：`protected override scheduled = (name) => …`。

- **名字**不能以 `syncline:` 开头，并且必须是格式正确的文本，不含孤立代理项。
- **一次 `schedule` 可能让 `scheduled(name)` 运行不止一次**：如果对象在运行期间被重置，它会再运行一次。让它可以安全地重复执行。
- **它抛出的错误会被报告，不会重试。** 见[云端代码中的错误](errors.md#云端代码中的错误)。
- **重置对象的任务会推迟它。** 见[需要知道的事](limits.md#需要知道的事)中的定时任务。

### `forward(request, namespace, verify)`

在你的 Worker 的 `fetch` 中应答私有空间的同步请求。它从请求中取出 token 传给 `verify`，再把请求转发给以 `verify` 返回的 `space` 命名的 Durable Object。

```ts
    if (pathname === '/sync')
      return forward(request, env.USER_SPACE, async (token) => {
        const user = await verifyToken(token, env.TOKEN_SECRET);
        return user && { space: user.id, expiresAt: user.expiresAt };
      });
```

- **`namespace`** 是你的 `SynclineSpace` 类的 Durable Object 命名空间。
- **`verify(token)`** 对你接受的 token 返回 `{ space, expiresAt }`，`expiresAt` 为 epoch 毫秒；返回 `undefined` 表示拒绝。被拒绝的 token 得到 401 应答。
- **`expiresAt` 不是有限数时它会抛错**：这是 `verify` 的错误。
- **任何来源的 Web 应用都能通过它同步。** 它应答浏览器的 CORS 预检请求，并允许任何来源读取它的响应。

### `restoreSpace(namespace, name, at)`

把私有空间 `name` 恢复到最近 30 天内的时间 `at`（epoch 毫秒）。共享空间不能恢复。

- **对象可能没有重启时它被拒绝**，比如连接中断之后。恢复会保持待执行状态，在对象下次启动时生效，所以请再调用一次。
- **在已经生效的恢复之后再调用，会再次恢复到 `at`**，丢弃此后的写入。
- **导出器只在空间的下一次写入时带着 `reset` 重新导出。** 见[重建或恢复之后](../../guides/zh-CN/exports.md#重建或恢复之后)。

### 共享空间

由云端为许多用户写入的数据。[共享空间指南](../../guides/zh-CN/shared-spaces.md)一步步地搭建一个。

#### `SharedDefinition`

`{ schema, rules, shards?, chunkRows? }`：入口 Worker 和共享空间都读取的内容。

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

| 字段 | 说明 |
|---|---|
| `schema` | 空间的表。 |
| `rules` | 桶规则：规则名 → 表名 → `{ where?, by? }`。见[桶规则](../../guides/zh-CN/bucket-rules.md)。 |
| `shards` | 广播分片数，默认 16。修改前先读[共享空间](limits.md#共享空间)。 |
| `chunkRows` | 新设备起步用的保存点之间被修改的行数，默认 1,000。 |

- **`where`** 是一个静态 SQL 谓词，只读取该表的列。
- **`by`** 列出桶列：整数或文本类型的同步列。
- **一行属于桶 `[ruleName, ...byValues]`**，条件是它满足 `where`，且它的桶列都不为 null。
- **规则需要一个名字和至少一张表**，规则中的表声明的 `by` 列数量相同、类型相同。

#### `SynclineSharedSpace`

共享空间的 Durable Object 类。继承它，并调用 `super(ctx, env, { ...definition, broadcast, cloud?, validation?, onEvent?, retired? })`。

```ts
export class SharedSpace extends SynclineSharedSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { ...shared, cloud, broadcast: (bindings) => bindings.SHARED_BROADCAST });
  }
```

- **`broadcast`** 是一个从 `env` 返回广播命名空间的函数。
- **`cloud`、`validation`、`onEvent` 和 `retired`** 与 `SynclineSpace` 上的相同。`rules` 中的 `where` 也可以读取只在云端的列。
- **`mutate(write)` 是写入的唯一途径**，从你自己的方法中调用。在这里它返回一个 Promise：请 await 它。
- **`schedule`、`unschedule` 和 `scheduled`** 与 `SynclineSpace` 上的相同，它的 alarm 也以同样方式管理。
- **按名字访问对象**（`getByName` 或 `idFromName`）。它的广播分片以它的名字命名，所以不带名字的 ID（`idFromString`、`newUniqueId`）会抛错，名字长到放不下分片名时也会抛错。见[共享空间](limits.md#共享空间)。

#### `SynclineBroadcast`

广播分片的 Durable Object 类，分片持有设备的实时连接。继承它，并调用 `super(ctx, env, sharedNamespace, onEvent?)`。

```ts
export class SharedBroadcast extends SynclineBroadcast<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, env.SHARED_SPACE);
  }
}
```

不要覆盖 `alarm()` 或调用 `setAlarm`：它在自己的 alarm 中关闭已过期的连接。

#### `SynclineSharedEntry`

应答下载的 Worker 入口，前面有 Workers Cache。继承它并实现 `shared()`，返回共享空间的命名空间。

```ts
export class SharedEntry extends SynclineSharedEntry<Env> {
  protected shared() {
    return this.env.SHARED_SPACE;
  }
}
```

#### `forwardShared(request, route, verify)`

在你的 Worker 的 `fetch` 中应答共享空间的同步请求。

```ts
    if (pathname === '/shared') {
      const route = { entry: ctx.exports.SharedEntry, broadcast: env.SHARED_BROADCAST, space: 'shared', definition: shared };
      return forwardShared(request, route, async (token) => {
        const user = await verifyToken(token, env.TOKEN_SECRET);
        return user && { buckets: bucketsOf(user), expiresAt: user.expiresAt };
      });
    }
```

- **`route`** 是 `{ entry, broadcast, space, definition }`：你的入口、广播命名空间、共享空间的名字，以及它的 `SharedDefinition`。
- **`verify(token)`** 对你接受的 token 返回 `{ buckets, expiresAt }`，返回 `undefined` 表示拒绝。被拒绝的 token 得到 401 应答。
- **`entry` 就是 `ctx.exports.<YourEntry>` 本身。** Syncline 以订阅作为 props 调用它，不带 props 访问入口会抛错。
- **`buckets`** 是用户读取的桶：`[ruleName, ...params]`，文本列用字符串，整数列用数字。
- **`verify` 出错时它会抛错**：桶违反规则、桶超过 256 字节、订阅按 JSON 编码后超过 8,192 字节，或 `expiresAt` 不是有限数。
- **任何来源的 Web 应用都能通过它同步**，与 `forward` 相同。

### 安全

- token 过期时访问结束：HTTP 拉取每次都调用 `verify`，但已打开的连接会一直保有其 token 授予的空间或订阅，直到 `expiresAt`，所以在撤销访问必须很快生效的场合，让 token 的有效期短一些。
- 共享空间的拉取 URL 带有桶参数和主键（在游标中；在已落地的订阅中则经过 base64 编码，并未加密），所以它们会出现在所有记录 URL 的地方：桶参数和共享表的主键请用不透明的 ID，不要用邮箱或名字。
- Syncline 限制每次拉取的工作量，但不限制一个有效 token 拉取的频率，而缓存未应答的每次拉取都会读取计费行：如果 token 可能落入恶意者手中，在同步路由上添加速率限制规则。

### 类型

`SynclineEvent`（`onEvent` 收到的事件；见[事件](errors.md#事件)）、`Transaction`（`mutate` 的 `tx`）、`Exporter`（`{ position(): Promise<string | undefined>; write({ from, next, reset, patch }): Promise<void> }`）、`Identity`（`{ space, expiresAt }`）、`SharedIdentity`（`{ buckets, expiresAt }`）、`Bucket`、`BucketRules`、`Change`（一次写入中改动的一行）、`ValidationError`。
