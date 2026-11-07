<!-- Translated from docs/reference/faq.md; update both in the same commit. -->

# 常见问题

[English](../faq.md) | 简体中文

## 使用

### 离线时应用还能用吗？

能。读写都走本地数据库，设备重新联网后写入会自动上传。

### 两台设备同时改同一行会怎样？

云端按列、按到达顺序执行写入。两台设备改了同一列时，后到的写入生效；改的是不同列时，两边的修改都保留。

### 怎么知道同步完成了？

调用 `await syncline.sync()`。设备追上云端、且云端确认了所有本地写入后，它才会完成。

要做实时状态显示，读取 `status()` 或用 `onStatus` 订阅。`status().pending` 是尚未确认的写入数。

### 怎么让用户退出登录？

先上传这个用户的写入，再关闭数据库：

1. 停止写入。
2. 调用 `await syncline.sync()`。如果它被拒绝，`status().pending` 就是还没上传的写入数。
3. 调用 `await syncline.close()`，并给 `SynclineProvider` 传入 `undefined`。在 iOS 和 Android 上，还要调用 `stopBackgroundSync()`。

之后用下一个 `userID` 打开数据库时，会清除这个用户的私有数据和仅本地表，保留共享空间。如果还有待上传的写入，打开会失败并抛出 `PendingWritesError`，什么都不清除。`delete()` 会立即删除数据库，连同还没上传的写入，而且不报错。

### 怎么修改表结构？

先部署云端，再发布应用。

- **新增表或列**：两边都声明。设备会重新下载这张表。
- **删除表或列**：两边都写进 `retired`。已退役的名字不能再用。

新增表或列后，没升级的应用照常同步。退役了旧应用还在用的表或列后，旧应用会停止同步（`updateNeeded`），直到升级。

### 怎么在用户之间共享数据？

使用共享空间。数据由云端写入，每台设备只下载其 token 允许的部分。详见 [API](../api.md)（英文）中的 `openShared()`。

### 应用能在后台同步吗？

iOS 和 Android 可以。使用 `syncline/expo/background` 中的 `defineBackgroundSync` 和 `startBackgroundSync`。

### 能用 Expo Go 吗？

不能。Syncline 需要[开发构建](https://docs.expo.dev/develop/development-builds/introduction/)。

### 怎么连接 `wrangler dev`？

给 `openSyncline` 传入 `allowCleartext: true`。iOS 模拟器或浏览器用 `http://localhost:8787`，Android 模拟器用 `http://10.0.2.2:8787`。手机要先用 `npx wrangler dev --ip 0.0.0.0` 启动，再用电脑的局域网地址。其他场合一律用 `https://`。

## 报错

每种报错的含义和处理方法见[报错](errors.md)。
