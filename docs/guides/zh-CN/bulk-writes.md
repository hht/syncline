<!-- Translated from docs/guides/bulk-writes.md; update both in the same commit. -->

# 批量写入

[English](../bulk-writes.md) | 简体中文

如何向共享空间写入大量数据：首次导入，或在重建空间后重新填充。

## 分批写入

- 共享空间的一次写入最多改动 10,000 行。级联删除删掉的行也算在内。
- 更大的写入会抛出 `Mutation modified more than 10000 rows` 并回滚。
- 每批控制在几千行以内。超过 CPU 时间上限的写入会重置对象。

量级参考：向一个桶插入 10,000 行用了约 2 秒 CPU；把它们各自移到另一个桶用了约 5 秒。每条带 `where` 或 `by` 的规则都会增加每行的开销。

## 让重试安全

`mutate` 可能在写入已经提交之后才抛错，例如对象在通知设备时被重置。所以重试不能依赖失败的那次是否已经生效：

- 用 `upsert` 代替 `insert`，同一行写两次结果不变。
- 把进度和数据记在同一次写入里，进度和数据就不会对不上。

示例把进度记在一张只在云端的表里：

```ts
/** Cloud-only table: how far each import job has got. */
export const imports = sqliteTable('import_progress', { job: text().primaryKey(), after: text().notNull() });
```

每一批在一次 `mutate` 里 upsert 这批行和它的最后一个 ID。已存在的文档如果状态改变，还会把状态复制到它的版本和段落上，见[桶规则](bucket-rules.md)。这些复制也计入 10,000 行，超限的一批每次重试都会失败，所以重新导入子行多的文档时要用更小的批次：

```ts
  importDocuments(job: string, rows: (typeof document.$inferInsert)[]) {
    return this.mutate((tx) => {
      for (const row of rows) {
        const [before] = tx.select({ status: document.status }).from(document).where(eq(document.id, row.id)).all();
        tx.upsert(document, row);
        if (before && before.status !== row.status) this.#copyStatus(tx, row.id, row.status);
      }
      const last = rows.at(-1);
      if (last) tx.upsert(imports, { job, after: last.id });
    });
  }

  /** Returns the id of the last document a job imported, or undefined before its first batch. */
  imported(job: string) {
    const [row] = this.ctx.storage.sql.exec<{ after: string }>('SELECT after FROM import_progress WHERE job = ?', job).toArray();
    return row?.after;
  }
```

调用方按 ID 排序，从记录的 ID 之后开始。出现任何错误后，用同一个任务名再调用一次：

```ts
export async function importAll(space: DurableObjectStub<SharedSpace>, job: string, rows: (typeof document.$inferInsert)[], batch = 1000) {
  const after = await space.imported(job);
  const left = after === undefined ? rows : rows.filter((row) => row.id > after);
  for (let start = 0; start < left.length; start += batch) await space.importDocuments(job, left.slice(start, start + batch));
}
```

数据源是数据库时，用 `WHERE id > ? ORDER BY id LIMIT ?` 查询，而不是过滤数组。

示例的测试让三批中的第三批失败，然后续跑，并检查所有行都已写入。

## 连着的设备会看到什么

每一批提交后，设备都会收到通知。

- 消息不超过 24,000 字节的改动直接发给连着的设备。
- 更大的改动会让设备改为下载。这些下载经过 Workers Cache。
- 导入期间从头开始下载的设备，可能拿到最多 60 秒前缓存的起点，之后再下载那之后的改动。
- 新设备从最近的保存点开始，默认每改动 1,000 行记录一个（`chunkRows`）。

共享空间重建后，设备[可能先从缓存拿到旧数据](../../reference/zh-CN/edge-cases.md#重建之后设备可能先从缓存拿到旧数据)。
