<!-- Translated from docs/guides/upgrading.md; update both in the same commit. -->

# 升级云端

[English](../upgrading.md) | 简体中文

部署新的 Syncline 版本时已有空间会怎样，以及如何重建无法升级的空间。

## 哪些会保留

Syncline 在每个空间的存储里保存自己的表，与你的表放在一起。部署后，每个空间第一次启动时会原地升级这些表。

- **v0.1.0 及之后的版本**：它们创建的每个空间，在部署之后的版本后都能继续使用。Syncline 自己的表只会以新增升级步骤的方式改变。
- **回滚**：部署 v0.1.0 及之后的较早版本时，会撤销该版本不认识的步骤。
- **v0.1.0 之前**：未发布版本创建的空间不受支持，需要重建。

你自己的表按你的 schema 变化，见[常见问题](../../reference/zh-CN/faq.md#怎么修改表结构)。回滚也一样：如果回滚到的 Worker 版本仍然声明你后来已退役的名字，每个已把它记录为退役的空间都会抛错。

## 识别 v0.1.0 之前的空间

写入和下载照常，但每次闹钟都会在执行任何任务前报 `no such column: resets`。导出、后台清理和你自己的 `schedule` 回调都会停止。

## 重建

重建会删除空间里的所有数据。先把需要的数据复制出来，之后再写回去：见[批量写入](bulk-writes.md)。

设备会自行从头下载重建后的空间。设备上还没上传的写入会保留，并上传到新的空间，按新空间里的行执行：修改或删除重建时已删掉的行不会产生效果，新空间无法执行的写入会被[暂扣](../../reference/zh-CN/errors.md#被暂扣的写入)。共享空间重建后，设备[可能先从缓存拿到旧数据](../../reference/zh-CN/edge-cases.md#重建之后设备可能先从缓存拿到旧数据)。

### 单个共享空间：换一个名字

共享空间按名字访问，所以换一个名字就是一个新的空空间：

1. 修改 `forwardShared` 的 `space` 以及服务端写入使用的名字，例如从 `'shared'` 改为 `'shared-2'`。
2. 部署，再把数据写入新空间。

部署时已连接的设备要等连接结束才转到新空间，最迟在它们的 token 过期后一分钟。旧对象会保留其存储，直到你清空它。

### 整个类：分两次部署

要重建一个类的所有对象，就删除这个类再重新创建。这需要两次部署，按 Cloudflare 的[类迁移](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)进行。

下面的步骤重建共享空间类。它的广播类随之一起重建：两个类各自接收对方的绑定，而且广播对象不保存数据，删掉不会丢失什么。重建私有空间类时，只列出那一个类。

**第一次部署：删除。**

1. 从 `durable_objects` 中删除这两个类的绑定。
2. 删除所有用到这些绑定的东西：
   - `SharedSpace` 和 `SharedBroadcast`。
   - `SharedEntry`，以及它在 `exports` 下的条目。
   - `/shared` 路由。
   - 其他调用这个空间的代码，比如你的服务端写入。
3. 添加一个新标签的迁移：`{ "tag": "v2", "deleted_classes": ["SharedSpace", "SharedBroadcast"] }`。
4. 部署。

**第二次部署：创建。**

1. 恢复第一次部署删除的所有东西。
2. 再添加一个迁移：`{ "tag": "v3", "new_sqlite_classes": ["SharedSpace", "SharedBroadcast"] }`。
3. 部署。

两次部署之间，设备无法访问共享空间。

Cloudflare 要求删除类之前先去掉绑定，所以删除和创建不能放在同一次部署里。这样的部署会失败，错误码为 10061（`Cannot apply --delete-class migration to class 'SharedSpace' without also removing the binding that references it`），且不做任何改动。

如果你的 Worker 用 `exports` 而不是 `migrations` 声明 Durable Object，删除时改用 `"state": "deleted"`。见 [Durable Object 迁移](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)。
