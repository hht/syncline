# Testing the cloud side

English | [简体中文](zh-CN/testing.md)

Run your Worker's tests in the Workers runtime with Cloudflare's Vitest integration. This guide follows the [example tests](../../examples/cloudflare), which use `@cloudflare/vitest-plugin` 1.6.0 and Vitest 4.

See [Cloudflare's guide](https://developers.cloudflare.com/workers/testing/vitest-integration/) for installing it.

## Configure Vitest

Point the plugin at your wrangler configuration. Bindings only tests need go under `miniflare`:

```ts
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: join(import.meta.dirname, 'wrangler.jsonc') },
      miniflare: { bindings: { MIGRATIONS: await readD1Migrations(join(import.meta.dirname, 'migrations')), EXPORT_DELAY: '0' } },
    }),
  ],
```

- `MIGRATIONS` carries the D1 migrations to a setup file, which applies them before each test file.
- `EXPORT_DELAY` lets the example Worker set `exportDelay` to 0 in tests. Exports then run right after each write instead of 60 seconds later.

The setup file:

```ts
await applyD1Migrations(env.EXPORTS, env.MIGRATIONS);
```

## Test a shared space

Your tests write through your shared space's own methods, then download as a device would. The example's helpers `pull` and `connect` live in [`examples/cloudflare/client.ts`](../../examples/cloudflare/client.ts).

> [!NOTE]
> These helpers speak the format devices use between app and cloud. It is not a public API: it can change in any release, and the helpers with it.

Writes land in the buckets each token may read:

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

A connected device receives a write live:

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

The first message after connecting tells the device it is up to date, so the test reads it before writing.

## Test a private space with an exporter

Exports run in an alarm after the write, never inside it. Wait for the destination instead of checking right away:

```ts
/** Waits until the destination holds rows for space: exports run in an alarm after the write, not during it. */
const exportedTo = (space: string, rows: { id: string; body: string }[]) =>
  vi.waitFor(async () => expect(await exported(space)).toEqual(rows), { timeout: 10_000 });

test('a server write reaches D1 through the exporter', async () => {
  await env.USER_SPACE.getByName('user-1').addNote('n1', 'Hello');
  await exportedTo('user-1', [{ id: 'n1', body: 'Hello' }]);
});
```

## Things that differ from production

- Workers Cache does not answer requests in these tests. Every download reaches the Durable Object.
- Calling a Durable Object method that throws prints `uncaught exception` in the log even when the test handles the error.
