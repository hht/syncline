<!-- Translated from docs/reference/errors.md; update both in the same commit. -->

# 报错

[English](../errors.md) | 简体中文

Syncline 会自行从网络和云端故障中恢复，待上传的写入会一直保留到云端确认。当故障需要做决定时，同步会停止或写入会被暂扣，Syncline 会通知你的应用。

## 设备端

### 错误出现在哪里

- 选项或表声明有误时，`openSyncline` 抛错。
- 数据库无法打开时，`waitForReady()` 被拒绝。
- 写入违反规则时，`write()` 被拒绝，整个事务回滚。
- `status()` 和 `onStatus` 显示 `downloadError`、`uploadError` 和 `updateNeeded`。
- `sync()` 以状态中显示的同一个错误被拒绝；你中止它时，以 `signal.reason` 被拒绝。只有 `PendingWritesError` 和 `AccountMismatchError` 能用 `instanceof` 判断。
- `onHeld` 报告云端拒绝执行的写入。

应用的错误处理器（Web 上是 `reportError`，iOS 和 Android 上是 `ErrorUtils`）会收到：

- 在你的 `onStatus`、`onChange` 或 `onHeld` 监听器里抛出的错误。
- Syncline 自行绕过的问题，比如本地数据与云端不一致而重新下载、下载的值本地列装不下，或后台同步失败。

同步继续进行。请记录这些错误。

### 自动处理的情况

| 发生了什么 | 设备怎么做 |
|---|---|
| 离线，或连接断开、卡住 | 按退避间隔重试，恢复后上传待上传的写入 |
| `token` 抛错、返回 `undefined` 或 `null`，或超过 30 秒 | 设置 `downloadError`，按退避间隔重试 |
| 云端拒绝 token（HTTP 401） | 设置 `downloadError`，按退避间隔重试 |
| token 过期 | 获取新 token 后重连 |
| 云端关闭连接 | 取决于代码，见[连接错误](limits.md#连接错误) |

对于这些情况，你可以把 `downloadError` 或 `uploadError` 显示给用户；代码里没有需要修的。例外是云端一直拒绝的 token：检查 `verify`。用户退出登录时，调用 `close()`，而不是让 `token` 抛错，否则设备会一直重试。

### 写入抛错

`write()` 被拒绝，什么都不会保存。原因：

- `ValidationError`：某个值违反它的列声明（非空、枚举、长度、JSON、布尔值不是 0 或 1、实数列里的 Infinity）或你的 `validation` schema，或主键太长。`issues` 列出字段和原因。
- 某个值是它的列存不下的，比如整数列里不是数字的文本，或者小数。SQLite 会用它自己的错误拒绝，而不是 `ValidationError`。
- [值](limits.md#值)或[写入](limits.md#大小)超出了限制，比如无效文本、NaN，或行数过多。
- 某行通过外键引用了不存在的行。
- 写入了 `readOnly` 表。

修正数据后重新写入。

### 写入出现后又消失了

云端拒绝执行这条写入，比如它超出了某项[限制](limits.md)，或违反了你云端代码中的规则。云端会暂扣这条写入，而不是丢弃。

用 `onHeld` 监听，告诉用户哪里失败了。每条被暂扣的写入最多报告一次，时机是云端向这台设备确认这条写入时，所以由后台 `syncOnce` 收到确认的写入永远不会报给它。完整列表保存在云端，见[被暂扣的写入](#被暂扣的写入)。

### `waitForReady()` 被拒绝

数据库无法打开。`downloadError` 显示同一个错误，`sync()` 和 `resync()` 也以它被拒绝。原因：

- 声明与已存储的数据库不一致，比如修改了列类型。见[表结构](limits.md#表结构)。
- `PendingWritesError` 或另一个标签页，见下文。
- 无效的 `url`。

在 iOS 和 Android 上，打开失败会关闭数据库，但无效 `url` 除外：再次打开前先调用 `close()`。

共享空间不同：`openShared()` 在后台创建它的表，所以声明不一致时，它的 `waitForReady()` 仍然 resolve。失败显示在它的 `downloadError` 中，同时它会重试。

### 打开数据库时出现 `PendingWritesError`

上一个用户还有待上传的写入，用新的 `userID` 打开会删掉它们。

请上一个用户重新登录并完成同步。如果要丢弃这些写入，用 `discardPending: true` 打开。

### `downloadError` 中出现 `AccountMismatchError`

云端报告的账号和这个数据库首次同步时的账号不同。为避免数据上传到错误的账号，同步已停止。请用当前用户的 `userID` 重新打开数据库。

### `updateNeeded` 为 true

云端比应用新，或者应用用到了云端已退役的表或列。同步暂停。请发布应用更新。

### `downloadError` 提示等待云端部署

应用领先于云端。同步按退避间隔重试，待上传的写入保留。原因：

- 应用声明了云端没有的表或列，或者云端的声明不同，比如类型或键不同。部署带有它的云端。
- 云端运行的 Syncline 版本比应用旧。用应用所用的版本部署云端。
- 云端删掉了某张表或某一列却没有退役，所以等待永远不会结束。请在两边都把它写进 `retired`。云端和应用都回滚的情况，见[新增列之后把两端都回滚会停止同步](edge-cases.md#新增列之后把两端都回滚会停止同步)。

### `uploadError` 显示代码 1007

云端拒绝了上传的一批写入：无法解析，或超出了限制。上传会暂停，直到应用重启或调用 `resync()`。如果这些写入永远无法成功，用 `resync({ discardPending: true })` 丢弃。

### 加了触发器之后下载一直失败

同步表上的触发器抛错，可能阻塞下载或打开数据库。删除这个触发器，或者让它在 Syncline 修改行时不抛错。

### Web 应用只能在一个标签页里用

每个站点只能有一个标签页打开数据库。第二个标签页会失败，报错以 `Local database is open in another tab` 开头：它的 `waitForReady()` 被拒绝，`downloadError` 显示这个错误。关闭另一个标签页，再刷新当前页。

### Syncline 自己的表被修改了

Syncline 自己的表（`_syncline_*`）只能由 Syncline 修改。其中保存的待上传写入读不回来时，设备无法同步，也无法打开数据库。用 `delete()` 删除本地数据库即可恢复，但待上传的写入会丢失。

## 云端

### 被暂扣的写入

执行失败的上传写入会被暂扣，而不是丢弃。设备继续同步。

在你的 `SynclineSpace` 的方法中：

1. 用 `held()` 列出被暂扣的写入。每条都有 `reason` 和原始的 `changes`。
2. 修复原因：你的云端代码、某条规则或数据。
3. 调用 `resubmit(client, id)` 重新执行，传入新的 `changes` 替换它，或传入 `[]` 丢弃它。

### 云端代码中的错误

- schema 违反[表结构](limits.md#表结构)中写明由云端检查的规则时，`SynclineSpace` 和 `SynclineSharedSpace` 抛错。
- 没有名字，或名字对它的分片来说太长时，`SynclineSharedSpace` 也会抛错（见[共享空间](limits.md#共享空间)）。
- 写入违反规则时，`mutate()` 抛错并回滚，比如超出[限制](limits.md#大小)或 `ValidationError`。
- `verify` 返回它们无法使用的值时，`forward` 和 `forwardShared` 抛错，比如 `expiresAt` 不是有限数，或某个 bucket 违反了你的规则。设备的请求会失败：`downloadError` 显示它，设备按退避间隔重试。
- 你的 `scheduled(name)` 抛出的错误会交给 `reportError`，这个任务不会再执行。要重试，在其中调用 `schedule`。
- 你的任务反复导致对象重置时会被暂停，失败交给 `reportError`（见[反复导致对象重置的任务会暂停一天](edge-cases.md#反复导致对象重置的任务会暂停一天)）。

### 事件

给 `SynclineSpace`、`SynclineSharedSpace` 或 `SynclineBroadcast` 传入 `onEvent`，用来记录事件或发出报警。它收到一个 `SynclineEvent`。回调要快。它抛出的错误会交给 `reportError`，不影响同步。

对这些事件报警：

| 事件 | 含义 | 怎么做 |
|---|---|---|
| `write.held` | 一条上传的写入执行失败，被暂扣 | 见[被暂扣的写入](#被暂扣的写入) |
| `push.failed` | 一次上传无法解析（设备收到 1007）或无法保存（设备重试） | 读 `reason`。超出[存储限制](limits.md#云端存储)的空间会一直失败 |
| `export.failed` | 一个导出器失败。它会按退避间隔重试，目标端会落后 | 修复导出器或目标端 |
| `upkeep.failed` | 一个后台步骤失败，比如建索引。它会按退避间隔重试 | 一直失败时读 `reason` |
| `notice.failed` | 一个广播分片漏掉了一次实时更新。它会按退避间隔重试 | 一直失败时读 `reason` |
| `write.skipped` | 一台设备跳过了写入 ID。这不应该发生 | 带上这个事件[提交 issue](https://github.com/hht/syncline/issues) |

这些用于日志和指标：

| 事件 | 含义 |
|---|---|
| `values.dropped` | 一条上传的写入设置了已退役的表或列。这些值被丢弃，其余部分照常执行 |
| `write.resubmitted` | 一条被暂扣的写入在 `resubmit` 后执行了 |
| `schema.changed` | 对象启动时，有表或列进入或离开同步 |
| `cookie.reset` | 一台设备的位置不在共享空间的历史中，所以它重新下载全部数据 |
| `chunk.pulled` | 一台设备下载了一块数据行 |
| `connection.closed` | 云端关闭了一个连接，附带代码和原因 |
