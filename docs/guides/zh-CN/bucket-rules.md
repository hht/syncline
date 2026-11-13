<!-- Translated from docs/guides/bucket-rules.md; update both in the same commit. -->

# 桶规则

[English](../bucket-rules.md) | 简体中文

桶规则决定每台设备下载共享空间的哪些行。请先读[共享空间](shared-spaces.md)。

## `where` 能读什么

`where` 是针对单行的 SQL 条件，只能读这一行自己的列：子查询和其他表会在空间启动时被拒绝。

当子行应当只在父行可见时才可见，这一点就很关键：子行看不到父行。把决定可见性的值复制到每个子行上，并在同一次写入里一起修改所有副本。

## 示例：三层结构

一个文档有多个版本，一个版本有多个段落。所有人都能看到已发布的文档及其全部版本和段落。管理员能看到全部内容。

每个子行保存一份所属文档 `status` 的副本。设备不需要它，所以它是只在云端的列：

```ts
export const cloud = {
  import_progress: imports,
  revision: sqliteTable('revision', {
    id: text().primaryKey(),
    document_id: text().notNull(),
    number: integer().notNull(),
    status: text().notNull(),
  }),
  section: sqliteTable('section', {
    id: text().primaryKey(),
    revision_id: text().notNull(),
    body: text().notNull(),
    status: text().notNull(),
  }),
};
```

`where` 可以使用只在云端的列。规则按副本过滤：

```ts
    public: {
      document: { where: "status = 'published'" },
      revision: { where: "status = 'published'" },
      section: { where: "status = 'published'" },
    },
    admin: { document: {}, revision: {}, section: {} },
```

发布文档时在同一次 `mutate` 里更新副本，订阅 `public` 的设备就永远不会看到缺少版本和段落的已发布文档：

```ts
  setStatus(documentID: string, status: string) {
    return this.mutate((tx) => {
      tx.update(document, { id: documentID, status });
      this.#copyStatus(tx, documentID, status);
    });
  }

  /** Copies a document's status onto its revisions and sections, in the write that changes it. */
  #copyStatus(tx: Transaction, documentID: string, status: string) {
    const revisions = tx.select({ id: revision.id }).from(revision).where(eq(revision.document_id, documentID)).all();
    for (const { id } of revisions) {
      tx.update(cloud.revision, { id, status });
      for (const child of tx.select({ id: section.id }).from(section).where(eq(section.revision_id, id)).all())
        tx.update(cloud.section, { id: child.id, status });
    }
  }
```

`Transaction` 是 `tx` 的类型，从 `syncline/cloudflare` 导入。

新的子行在写入时复制该值：

```ts
      const [parent] = tx.select({ status: document.status }).from(document).where(eq(document.id, documentID)).all();
      if (!parent) throw new Error(`No document ${documentID}`);
      tx.upsert(cloud.revision, { id, document_id: documentID, number, status: parent.status });
      for (const child of sections) tx.upsert(cloud.section, { ...child, revision_id: id, status: parent.status });
```

一次写入最多改动 10,000 行，所以发布一个版本和段落加起来超过这个数的文档会抛错，且不做任何改动。见[批量写入](bulk-writes.md#分批写入)。

### 让管理员同时订阅两个桶

`bucketsOf` 给管理员 `public` 和 `admin` 两个桶。给 token 增加桶只下载新增的桶，去掉桶则会[重新下载全部数据](../../reference/zh-CN/edge-cases.md#从订阅去掉桶会重新下载全部内容)。始终保留 `public`，把用户提升为管理员时就只是增加 `admin`。

## 参数

`by` 让一条规则按每个取值产生一个桶：`team: { document: { by: ['team_id'] } }` 产生 `['team', <team_id>]`。

- 用不透明的 ID（例如 UUID）作参数。桶参数会出现在下载 URL 里，而 URL 会出现在所有记录 URL 的地方。不要用邮箱或名字。
- 出于同样的原因，共享表的主键也要用不透明的值。
- 一个桶编码为 JSON 后最多 256 字节。
- `by` 列必须是设备会收到的整数列或文本列。只有 `where` 可以使用只在云端的列。

## 订阅大小

一个 token 的桶排序后编码为 JSON，最多 8,192 字节。规则只有一个 UUID 参数时，约为 150 个桶。超过时 `forwardShared` 会抛错。

如果用户可能需要更多桶，就按更粗的粒度分桶：

- 不要为用户能看到的每一项各建一个桶，而是给每项加上分组 ID，订阅用户所在的分组。
- 所有人都能读的数据不需要参数：一个像 `public` 这样的桶就能覆盖全部。

修改规则会把已有的行移到新的桶里，代价见下文。

## 写入成本

表上每条带 `where` 或 `by` 的规则，会让每次插入多计费 1 行写入；更新改到规则用到的列时，也多计费 1 行。两者都没有的规则（如 `admin`）不增加成本。

## 上线后修改规则

修改覆盖某张表的规则，会让每台设备重新下载整张表。新数据下载完成前，设备继续显示旧的行。

- 字符串字面量之外的空白和大小写不算修改。
- 给表增加或去掉一条规则算修改：这张表会被重新下载。
- 部署后，云端[重新统计这张表](../../reference/zh-CN/limits.md#共享空间)。
- 在线设备[得知规则变化会有延迟](../../reference/zh-CN/edge-cases.md#在线设备得知规则改变会有延迟)。
- 新规则放进[超大的桶](../../reference/zh-CN/edge-cases.md#超大的桶没有设备能订阅)里的行不会到达任何设备。

所以对一张大表来说，每次修改规则都要让每台设备完整下载一遍，你也要为读取的行付费。尽量在上线前定好规则，并把修改合并到一次部署里。
