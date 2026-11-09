<!-- Translated from docs/guides/upgrading.md; update both in the same commit. -->

# 升级云端

[English](../upgrading.md) | 简体中文

部署新的 Syncline 版本时已有空间会怎样，以及如何重建无法升级的空间。

## 哪些会保留

Syncline 在每个空间的存储里保存自己的表，与你的表放在一起。部署后，每个空间第一次启动时会原地升级这些表。

- **v0.1.0 及之后的版本**：它们创建的每个空间，在部署之后的版本后都能继续使用。Syncline 自己的表只会以新增升级步骤的方式改变。
- **回滚**：部署 v0.1.0 及之后的较早版本时，会撤销该版本不认识的步骤。
- **v0.1.0 之前**：未发布版本创建的空间不受支持，需要重建。

你自己的表按你的 schema 变化，见[常见问题](../../reference/zh-CN/faq.md#怎么修改表结构)。

## 识别 v0.1.0 之前的空间

写入和下载照常，但每次闹钟都会在执行任何任务前报 `no such column: resets`。导出、后台清理和你自己的 `schedule` 回调都会停止。

## 重建

重建会删除空间里的所有数据。先把需要的数据复制出来，之后再写回去：见[批量写入](bulk-writes.md)。

设备会自行从头下载重建后的共享空间。约 60 秒内，新设备可能从缓存拿到旧数据，之后云端会让它们重新下载。

### 单个共享空间：换一个名字

共享空间按名字访问，所以换一个名字就是一个新的空空间：

1. 修改 `forwardShared` 的 `space` 以及服务端写入使用的名字，例如从 `'shared'` 改为 `'shared-2'`。
2. 部署，再把数据写入新空间。

旧对象会保留其存储，直到你清空它。

### 整个类：分两次部署

要重建一个类的所有对象，就删除这个类再重新创建。这需要两次部署，按 Cloudflare 的[类迁移](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)进行：

**第一次部署：删除。**

1. 从 `durable_objects` 中删除这个类的绑定。
2. 从代码中删除这个类，以及所有对其绑定的使用。
3. 添加一个新标签的迁移：`{ "tag": "v2", "deleted_classes": ["SharedSpace"] }`。
4. 部署。

**第二次部署：创建。**

1. 恢复这个类和它的绑定。
2. 再添加一个迁移：`{ "tag": "v3", "new_sqlite_classes": ["SharedSpace"] }`。
3. 部署。

Cloudflare 要求删除类之前先去掉绑定，所以删除和创建不能放在同一次部署里。这样的部署会失败，错误码为 10061（`Cannot apply --delete-class migration to class 'SharedSpace' without also removing the binding that references it`），且不做任何改动。

重建共享空间类不影响它的广播类：广播对象不保存数据，会按名字找到新的空间。共享空间被删除期间它的绑定不存在，所以第一次部署还要去掉 `/shared` 路由，以及广播类对这个绑定的使用。

如果你的 Worker 用 `exports` 而不是 `migrations` 声明 Durable Object，删除时改用 `"state": "deleted"`。见 [Durable Object 迁移](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)。
