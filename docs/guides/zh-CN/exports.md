<!-- Translated from docs/guides/exports.md; update both in the same commit. -->

# 导出

[English](../exports.md) | 简体中文

导出器把私有空间的行复制到别处：用于跨用户查询、分析、搜索的数据库。只有私有空间（`SynclineSpace`）有导出器。

本指南构建一个写入 D1 的导出器。代码在 [`examples/cloudflare/notes.ts`](../../../examples/cloudflare/notes.ts)。

## 约定

导出器有两个方法：

- `position()` 返回目的地上次保存的位置；第一次导出之前返回 `undefined`。
- `write({ from, next, reset, patch })` 写入一块改动，并把 `next` 保存为新位置。

把行和 `next` 一起保存，且只在保存的位置仍等于 `from` 时保存。这样重试或重叠的调用不会改动任何东西。失败时抛错；Syncline 会从同一位置重新投递这一块。

`patch` 包含这些操作：

| `op` | 含义 |
|---|---|
| `put` | 当前整行，包含所有同步列 |
| `del` | 这个主键的行已不存在 |
| `clear` | 删除为这个空间导出的所有行；随后是一份完整快照 |
| `drop` | 一张表离开了同步；带 `columns` 时是其中某些列 |

## D1 导出器

目的地的表：

```sql
CREATE TABLE exported_note (space TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (space, id));
CREATE TABLE export_position (space TEXT PRIMARY KEY, position TEXT NOT NULL);
```

每条语句都带同一个条件：保存的位置仍是 `from`。

```ts
// Runs a statement only while the space's stored position (?1, ?2) is still the chunk's from.
const current = '(SELECT position FROM export_position WHERE space = ?1) IS ?2';
```

每个操作对应一条带条件的语句：

```ts
function statementOf(db: D1Database, at: unknown[], op: Op) {
  if (op.op === 'clear' || (op.op === 'drop' && op.table === 'note' && !('columns' in op)))
    return db.prepare(`DELETE FROM exported_note WHERE space = ?1 AND ${current}`).bind(...at);
  if (op.op === 'put' && op.table === 'note')
    return db
      .prepare(
        `INSERT INTO exported_note (space, id, body) SELECT ?1, ?3, ?4 WHERE ${current} ON CONFLICT DO UPDATE SET body = excluded.body`,
      )
      .bind(...at, op.row.id, op.row.body);
  if (op.op === 'del' && op.table === 'note')
    return db.prepare(`DELETE FROM exported_note WHERE space = ?1 AND id = ?3 AND ${current}`).bind(...at, op.key.id);
  return undefined;
}
```

批次的最后一条语句在同一条件下保存 `next`：

```ts
    write: async ({ from, next, patch }) => {
      const at = [space(), from ?? null];
      const statements = patch.flatMap((op) => statementOf(db, at, op) ?? []);
      const save = `INSERT INTO export_position (space, position) SELECT ?1, ?3 WHERE ${current} ON CONFLICT DO UPDATE SET position = excluded.position`;
      await db.batch([...statements, db.prepare(save).bind(...at, next)]);
    },
```

D1 把一个 [batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) 作为一个事务执行。即便如此每条语句仍带条件，所以用同一个 `from` 再次调用时，会发现位置已经前进，什么都不写。

把它接到空间上，每个空间在目的地有各自的位置：

```ts
    super(ctx, env, { note }, { exporters: { d1: exportNotes(env.EXPORTS, ctx.id) }, ...exportDelay });
```

导出器只在运行时读取空间的名字。对象没有名字时它会抛错，导出随之重试，而不是写到别的键下：

```ts
  const space = () => {
    if (id.name === undefined) throw new Error('This space has no name to export under: reach it with getByName');
    return id.name;
  };
```

只有按不超过 1,024 字节的名字访问对象时，Cloudflare 才会给它名字（[`name`](https://developers.cloudflare.com/durable-objects/api/id/#name)）。

## 时机

- 第一次导出在写入后约 60 秒执行（`exportDelay`）。手动验证时，至少等这么久再查询目的地。
- 导出失败会退避重试，间隔最长 1 小时。
- 每次闹钟最多导出 10 分钟（`exportBudget`），然后在下一次继续。
- 部署新增的导出器，会在该空间的对象下次启动或下次写入时收到完整快照。

测试中把 `exportDelay` 设为 0。见[测试](testing.md)。

## 重建或恢复之后

重建的空间，或用 `restoreSpace` 恢复到目的地最后一次导出之前某个时间的空间，不再认识目的地保存的位置。它的下一次导出是一份完整快照：

- `reset` 为 `true`。
- `patch` 以 `clear` 开头。

先删除为这个空间导出过的所有行，再写入快照。在示例中，这个 `clear` 只删除这个空间的行。它的测试重建一个空间，并检查只剩下新的行。

`restoreSpace` 之后，这发生在空间的下一次写入时。
