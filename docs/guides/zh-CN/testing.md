<!-- Translated from docs/guides/testing.md; update both in the same commit. -->

# 测试云端

[English](../testing.md) | 简体中文

用 Cloudflare 的 Vitest 集成，在 Workers 运行时里跑 Worker 的测试。本指南沿用[示例测试](../../../examples/cloudflare)，它们使用 `@cloudflare/vitest-plugin` 1.6.0 和 Vitest 4。

安装方法见 [Cloudflare 的指南](https://developers.cloudflare.com/workers/testing/vitest-integration/)。

## 配置 Vitest

把插件指向你的 wrangler 配置。只有测试需要的绑定放在 `miniflare` 下：

```ts
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: join(import.meta.dirname, 'wrangler.jsonc') },
      miniflare: { bindings: { MIGRATIONS: await readD1Migrations(join(import.meta.dirname, 'migrations')), EXPORT_DELAY: '0' } },
    }),
  ],
```

- `MIGRATIONS` 把 D1 迁移交给 setup 文件，在每个测试文件之前执行。
- `EXPORT_DELAY` 让示例 Worker 在测试中把 `exportDelay` 设为 0。导出会在每次写入后立即执行，而不是 60 秒后。

setup 文件：

```ts
await applyD1Migrations(env.EXPORTS, env.MIGRATIONS);
```

## 测试共享空间

测试通过共享空间自己的方法写入，再像设备一样下载。示例的辅助函数 `pull` 和 `connect` 在 [`examples/cloudflare/client.ts`](../../../examples/cloudflare/client.ts) 里。

> [!NOTE]
> 这些辅助函数使用应用与云端之间的通信格式。它不是公开 API：任何版本都可能改变它，辅助函数也要随之修改。

写入落在每个 token 能读的桶里：

```ts
test('a pull returns the rows of subscribed buckets only', async () => {
  await space().importDocuments('first', [
    { id: 'd1', team_id: 'team-a', level: 9, status: 'published', title: 'Published' },
    { id: 'd2', team_id: 'team-a', level: 9, status: 'draft', title: 'Draft' },
    { id: 'd3', team_id: 'team-b', level: 9, status: 'draft', title: 'Team B draft' },
    { id: 'd4', team_id: 'team-c', level: 2, status: 'draft', title: 'Level 2 draft' },
  ]);
  expect(ids((await pull(await tokenFor(reader))).rows.document)).toEqual(['d1']);
  expect(ids((await pull(await tokenFor({ ...reader, teams: ['team-b'] }))).rows.document)).toEqual(['d1', 'd3']);
  expect(ids((await pull(await tokenFor({ ...reader, level: 2 }))).rows.document)).toEqual(['d1', 'd4']);
  expect(ids((await pull(await tokenFor(admin))).rows.document)).toEqual(['d1', 'd2', 'd3', 'd4']);
});
```

连着的设备实时收到写入：

```ts
test('a connected device receives a server write live', async () => {
  const token = await tokenFor(reader);
  const { cookie } = await pull(token);
  const device = await connect(token, cookie);
  await device.next();
  await space().importDocuments('live', [{ id: 'l1', team_id: 'team-a', level: 9, status: 'published', title: 'Live' }]);
  expect(await device.next()).toEqual([
    { op: 'put', table: 'document', key: { id: 'l1' }, row: { id: 'l1', team_id: 'team-a', level: 9, status: 'published', title: 'Live' } },
  ]);
  device.close();
});
```

连接后的第一条消息告诉设备它已是最新，所以测试先读掉它再写入。

## 测试带导出器的私有空间

导出在写入之后的闹钟里执行，不在写入过程中。等待目的地出现数据，而不是立即检查：

```ts
/** Waits until the destination holds rows for space: exports run in an alarm after the write, not during it. */
const exportedTo = (space: string, rows: { id: string; body: string }[]) =>
  vi.waitFor(async () => expect(await exported(space)).toEqual(rows), { timeout: 10_000 });

test('a server write reaches D1 through the exporter', async () => {
  await env.USER_SPACE.getByName('user-1').addNote('n1', 'Hello');
  await exportedTo('user-1', [{ id: 'n1', body: 'Hello' }]);
});
```

## 与生产环境的差别

- 这些测试中 Workers Cache 不会响应请求，每次下载都打到 Durable Object。
- 调用的 Durable Object 方法抛错时，即使测试处理了这个错误，日志里也会打印 `uncaught exception`。
