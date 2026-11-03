# 接口

按包的入口列出，入口按代码跑在哪分：App（`syncline/expo`、`syncline/expo/background`、`syncline/react`、`syncline/metro`）与云端（`syncline/cloudflare`）。

多数接入只用到：App 上的 `openSyncline`（`syncline/expo`）与 `SynclineProvider`、`useQuery`、`useSyncline`（`syncline/react`），云端的 `SynclineSpace` 与 `forward`（`syncline/cloudflare`）；先看 [README](../../README.md) 的「一眼看完」，其余按需查下文。

## `syncline/expo`

iOS、Android 与 web 是同一个入口、同样的选项：打包时手机上取原生模块的实现，web 上取 Syncline 自带的专用 Worker 的实现。

### `openSyncline(options): Syncline`

打开（没有就建）一个本机库，照 `schema` 建表、补列，开始同步私有空间。手机上同一个库在一个进程里只能开一份，再开就抛错（先 `close`）；后台任务的 `syncOnce` 正开着同一个人（`owner`）的库时，接管那一份（用的是 `syncOnce` 打开时给的选项）；开着别人的库就先关掉它，再按这次的选项打开。

| 选项 | 说明 |
|---|---|
| `name` | 库的名字，文件是「名字.db」；整个 App 一个 |
| `owner` | 可选，私有空间属于谁（登录的用户的 id）：和库里记着的不同就先清掉上一个人的私有数据与本机专用的表，共用空间留着；库里还没记过就只记下；不给就不记、不清。上一个人还有没上传的写时不清、打开出错（`PendingWrites`，`owner` 是上一个人，`count` 是条数；手机上 `openSyncline` 抛出，web 上记成私有空间的 `downloadError`）：让上一个人登录同步完再换人，或给 `discardPending` 丢掉它们。退出登录前看 `status().pending`，不为 0 就先 `sync()` |
| `discardPending` | 可选，换了人时上一个人没上传的写也丢掉（见 `owner`）；`syncOnce` 不理它 |
| `schema` | 同步的表：`{ 表名: Drizzle 表 }` |
| `localOnly` | 可选，本机专用的表：`{ 表名: Drizzle 表 }`，不同步 |
| `url` | 私有空间的同步地址（`https://`），WebSocket 与 HTTP 下载都用它；不能带查询串或 `#`（参数由 Syncline 加，云端认不出别的），带了打开时就抛错 |
| `token` | `() => Promise<string>`，每次连接前调用；快过期时应给新的 |
| `validation` | 可选，`Map<Drizzle 表, Standard Schema>`，写的时候按它校验 |
| `readOnly` | 可选，只由云端写的同步表（Drizzle 表的数组）：设备只读，本机写改到就抛错、整条回滚；与云端的 `readOnly` 相同 |
| `retired` | 可选，删掉的同步表与列（`表.列`），与云端的 `retired` 相同：不再同步，打开时从库里删掉（有待上传也是：先撤回、删掉、再重放）；不能再声明 |
| `checksumRowsPerDay` | 可选，在线校验和每天至多对多少行，默认 100 万（云端当场算，每读一行计费） |
| `token` 的要求 | 云端会告诉设备身份还有多久到期，设备在到期前 1 到 4 分钟之间自己重连、再调一次 `token`，这时要给新的。Firebase 的 `getIdToken()` 在 iOS、Android 上离到期 5 分钟以内就换新的；web 上（Firebase JS SDK）只用 Auth 时离到期 30 秒以内才换，到期前 1 到 4 分钟调它拿到的还是旧的 |

### `syncOnce(options, { signal }): Promise<void>`

只在 iOS、Android：同步一次，给后台任务用（App 不在前台时被系统叫醒的那几十秒）。连上，推完没上传的写、拉到最新就成功。这个进程里已经开着这个库（App 还在后台活着）就用开着的那份、不关；没开就按 `options`（同 `openSyncline`）打开，同步完关掉，不留连接；同步期间用户点开了 App，`openSyncline` 接管同一个人的那份，`syncOnce` 就不再关它。`signal` 中止（如超时）或出错就失败（换了人、上一个人还有没上传的写时以 `PendingWrites` 失败），打开的库照样关掉；iOS 收回后台时间时 App 随即被挂起，不保证执行到关库。只同步私有空间。

### `Syncline`

| 成员 | 说明 |
|---|---|
| `name` | 库的名字 |
| `db` | 只读的 Drizzle 库 |
| `write(body): Promise<T>` | 一次本机写：`body(tx)` 在一个本机事务里，`tx` 是可读可写的 Drizzle 库 |
| `onChange(listener): () => void` | 同步表与本机专用的表变了之后调用，给出改到的表名（`ReadonlySet<string>`） |
| `tablesOf(sql): Promise<string[]>` | 一条查询读哪些表（不执行） |
| `onHeld(listener): () => void` | 本机写被云端扣下时调用，给出 `{ reason, changes }[]` |
| `status(): SyncStatus` | 当前同步状态 |
| `onStatus(listener): () => void` | 状态每次变了调用 |
| `sync({ signal }?): Promise<void>` | 立即同步，等到补齐、本机的写都被确认（已追平立刻成功）；出错或 `signal` 中止时失败，云端以 1007 拒收过推上去的写时立刻失败 |
| `resync({ signal, discardPending }?): Promise<void>` | 整份重下、换掉本机的同步表（本机数据坏了时用）；没上传的写留着，重下完照常推上去。`discardPending: true` 时连没上传的写一起丢（同步一直推不上去、云端以 1007 拒收时用） |
| `reconnect(): void` | 立刻换一条连接、重新调 `token`：令牌变了（权限变了，共用空间看得见的范围随之变）时调用，如在 Firebase 的 `onIdTokenChanged` 里 |
| `shared(name, { schema, url, token?, owner? })` | 同一个库里的一个共用空间（只读），有自己的 `status`、`onStatus`、`sync`、`resync`、`reconnect`；看得见哪些行由云端按 token 定；`owner`（登录的人）和上次不同就先清掉上一个人看过的 |
| `close(): Promise<void>` | 停下同步、关库 |
| `delete(): Promise<void>` | 关库并删掉库文件（清除本机数据） |

### 类型

`Database`（Drizzle 库）、`Schema`、`Syncline`、`SyncStatus`、`ValidationError`（改到的行不合声明；`issues` 给出字段路径与原因）、`PendingWrites`（见 `owner`）、`AccountMismatch`（云端说的空间与本机库第一次同步时记下的不同，即这台设备上换了账号：同步停下、不推，报在 `downloadError`，`stored`、`cloud` 是两边的空间；按当前账号重新打开，换 `owner`）。

## `syncline/expo/background`

可选，只在 iOS、Android，要装 `expo-background-task` 与 `expo-task-manager`，`app.json` 的 `plugins` 加上 `expo-background-task`。

| 导出 | 说明 |
|---|---|
| `defineBackgroundSync(options)` | 定义后台同步要做的事，在入口加载的模块顶层调用；`options` 是 `() => OpenOptions \| undefined`（可以是 Promise），给出这次要同步的库，`undefined` 时什么也不做 |
| `startBackgroundSync(minimumInterval?)` | 让系统定时叫醒 App 同步，至少隔 `minimumInterval` 分钟（默认、也是最小 15） |
| `stopBackgroundSync()` | 停止 |

## `syncline/react`

要在 TanStack 的 `QueryClientProvider` 里面用。

| 导出 | 说明 |
|---|---|
| `SynclineProvider` | `<SynclineProvider value={space}>`：给子树一个库；`value` 可以是 `undefined`（没登录）。换了库或卸载时丢掉上一个库的查询缓存 |
| `useQuery(build)` | `build(db)` 写一条 Drizzle 查询；返回 TanStack 的查询结果，读到的表变了才重跑 |
| `useSyncline()` | 当前的库（写、手动同步、共用空间用）；没有就抛错 |
| `useSyncStatus()` | 当前库的同步状态，变了就重新渲染 |

## `syncline/metro`

`withSyncline(config)`：包一层接入方的 Metro 配置（`metro.config.js`），返回同一个配置：起 Metro 时编好 web 用的 wasm（没改时一两秒，编不了就抛错），`.wasm` 当资源打包。

## `syncline/cloudflare`

### `class SynclineSpace<Env>`

私有空间的 DO，继承它：`super(ctx, env, schema, options?)`，照 `schema`（与设备同一份）建表、补列。

| 选项 | 说明 |
|---|---|
| `cloud` | 云端的表：同名的同步表在云端的样子（多出只在云端的列）与只在云端的表 |
| `retired` | 删掉的表与列（`表.列`），不再回到同步，与设备上的一样；不能再声明 |
| `validation` | 同设备，云端对上传的写与服务端的写再查一遍 |
| `readOnly` | 只由云端写的同步表，与设备的相同：只有服务端的写（`mutate`）改它们，设备推来的写改到就扣下（改过的客户端才推得出），重新提交时改到也抛错。不能引用设备能写的表（删父行会连带删掉它们的行），打开时查。把已有的表改成只读，先发不再写它的 App：没升级的 App 写它也会被扣下 |
| `events` | 云端事件的回调 |
| `writeQuota` | 设备上传的写入额度 `{ rate, burst }`：每秒补 `rate` 行、至多攒 `burst` 行（行是改动条数），超了以 1013 关连接；不给就不限，见[限制](limits.md) |
| `dailyWrites` | 设备上传的写每天（UTC）至多写几行（计费的行写，含索引与提交记录；服务端的写不算），到了以 1013 关连接、第二天照常；不给就不限，见[限制](limits.md) |
| `connections` | 同时至多几条连接（正整数），默认 32，见[限制](limits.md)；一个用户设备多时调大 |
| `exports` | 导出者：名字 → `Exporter`（`position()`、`write(chunk)`） |
| `exportDelay` | 写了之后多久导出，默认 60 000 毫秒 |
| `exportBudget` | 一次 alarm 最多导多久，默认 600 000 毫秒；导出者到时候还没回话就算这次失败、按退避重排 |

| 受保护的成员（在你的方法里调用；是实例上的函数，经 RPC 调不到） | 说明 |
|---|---|
| `mutate(write)` | 服务端的写，同步执行 |
| `held({ limit?, after? })` | 扣下的写：`{ client, id, reason, version, at, changes }[]`，`changes` 是推来的原样（设备有缺陷时可以不是一组认得出的改动，类型是 `unknown`），一页默认 100 条，`after` 是上一页最后一条的 `version` |
| `resubmit(client, id, changes?)` | 重新提交一条扣下的写；已经不扣着的、不给 `changes` 而原样的改动认不出的、改到只由云端写的表的抛错 |
| `schedule(name, at)`、`unschedule(name)` | 自己的定时：最迟在 `at` 调 `scheduled(name)`；名字不能以 `syncline:` 开头 |
| `scheduled` | 覆盖它（`protected override scheduled = (name) => …`）接自己的定时 |

alarm 由 Syncline 管（导出与自己的定时共用一个），不要覆盖 `alarm()`、不要自己调 `setAlarm`。`SynclineSharedSpace` 的 `mutate`、`schedule`、`unschedule`、`scheduled` 同样。

### `forward(request, namespace, verify)`

入口 Worker 里同步请求的入口：取出 token 交给 `verify`，它返回 `{ space, expiresAt }` 或 `undefined`；认出的转给名为 `space` 的 DO，认不出回 401。

### `restoreSpace(namespace, name, at)`

把一个私有空间恢复到 `at`（毫秒时刻）。

### 共用空间

| 导出 | 说明 |
|---|---|
| `SharedDefinition` | `{ schema, buckets, shards?, chunkRows? }`，入口与共用空间用同一份；`buckets` 是桶规则：规则名 → 表名 → `{ where?, by? }`（`where` 是只用这张表的列的 SQL 条件，`by` 是分桶列），一行满足条件、分桶列都不为空就在「规则名加分桶列的值」那个桶里 |
| `class SynclineSharedSpace<Env>` | 共用空间的 DO：`super(ctx, env, { ...definition, broadcast, validation?, events?, retired? })`（`retired` 同 `SynclineSpace`）；`protected mutate(write): Promise<void>` |
| `class SynclineBroadcast<Env>` | 广播分片的 DO：`super(ctx, env, sharedNamespace, events?)`；alarm 由它管（到期的连接按 alarm 关掉），不要覆盖 `alarm()`、不要自己调 `setAlarm` |
| `abstract class SynclineSharedEntry<Env>` | 开了缓存的入口：实现 `protected shared()`，返回共用空间的命名空间 |
| `forwardShared(request, route, verify)` | 入口 Worker 里的入口：`route` 是 `{ entry, broadcast, space, definition }`，`verify` 返回 `{ buckets, expiresAt }`（订阅的桶：`[规则名, 参数…]`，文本列的参数给字符串、整数列的给数；分桶列只能是整数或文本），认不出返回 `undefined`（回 401）；桶不合规则、订阅编成 JSON 超过 8192 字节是接入方的错，抛错 |

### 类型

`Exporter`（`{ position(): Promise<string | undefined>; write({ from, next, reset, patch }): Promise<void> }`）、`Identity`（`{ space, expiresAt }`）、`SharedIdentity`（`{ buckets, expiresAt }`）、`Bucket`、`BucketRules`、`Change`（一条写改到的一行）、`ValidationError`。
