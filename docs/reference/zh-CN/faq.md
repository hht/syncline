<!-- Translated from docs/reference/faq.md; update both in the same commit. -->

# 常见问题

[English](../faq.md) | 简体中文

## 使用

### 离线时应用还能用吗？

能。读写都走本地数据库，设备重新联网后写入会自动上传。

### 两台设备同时改同一行会怎样？

云端按列、按到达顺序执行写入。两台设备改了同一列时，后到的写入生效；改的是不同列时，两边的修改都保留。

### 怎么知道同步完成了？

调用 `await space.sync()`。设备追上云端、且云端确认了所有本地写入后，它才会完成。

要做实时状态显示，读取 `status()` 或用 `onStatus` 订阅。`status().pending` 是尚未确认的写入数。

### 怎么修改表结构？

先部署云端，再发布应用。

- **新增表或列**：两边都声明。设备会重新下载这张表。
- **删除表或列**：两边都写进 `retired`。已退役的名字不能再用。

新增表或列后，没升级的应用照常同步。退役了旧应用还在用的表或列后，旧应用会停止同步（`updateNeeded`），直到升级。

### 怎么在用户之间共享数据？

使用共享空间。数据由云端写入，每台设备只下载其 token 允许的部分。详见 [API](../api.md)（英文）中的 `shared()`。

### 应用能在后台同步吗？

iOS 和 Android 可以。使用 `syncline/expo/background` 中的 `defineBackgroundSync` 和 `startBackgroundSync`。

### 能用 Expo Go 吗？

不能。Syncline 需要[开发构建](https://docs.expo.dev/develop/development-builds/introduction/)。

### 怎么连接 `wrangler dev`？

给 `openSyncline` 传入 `allowCleartext: true`。iOS 模拟器或浏览器用 `http://localhost:8787`，Android 模拟器用 `http://10.0.2.2:8787`。手机要先用 `npx wrangler dev --ip 0.0.0.0` 启动，再用电脑的局域网地址。其他场合一律用 `https://`。

## 报错

### 写入出现后又消失了

云端拒绝执行这条写入，比如它超出了某项[限制](limits.md)，或违反了你云端代码中的规则。云端会暂扣这条写入，而不是丢弃。

用 `onHeld` 监听，告诉用户哪里失败了。问题修复后，在云端用 `resubmit` 重新提交或丢弃这条写入。

### 打开数据库时出现 `PendingWrites`

上一个用户还有待上传的写入，用新的 `userID` 打开会删掉它们。

请上一个用户重新登录并完成同步。如果要丢弃这些写入，用 `discardPending: true` 打开。

### `downloadError` 中出现 `AccountMismatch`

云端报告的账号和这个数据库首次同步时的账号不同。为避免数据上传到错误的账号，同步已停止。请用当前用户的 `userID` 重新打开数据库。

### `updateNeeded` 为 true

云端比应用新，或者应用用到了云端已退役的表或列。请发布应用更新。

### `uploadError` 显示代码 1007

云端拒绝了上传的一批写入：无法解析，或超出了限制。上传会暂停，直到应用重启或调用 `resync()`。如果这些写入永远无法成功，用 `resync({ discardPending: true })` 丢弃。

### 加了触发器之后下载一直失败

同步表上的触发器抛错，可能阻塞下载或打开数据库。删除这个触发器，或者让它在 Syncline 修改行时不抛错。

### Web 应用只能在一个标签页里用

每个站点只能有一个标签页打开数据库。关闭另一个标签页，再刷新当前页。
