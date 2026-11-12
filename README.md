# Syncline

English | [简体中文](README.zh-CN.md)

Offline-first SQLite sync for Expo apps, backed by Cloudflare.

Your app reads and writes a local SQLite database. Syncline keeps it in sync with the cloud in the background. It works offline and catches up when the network returns.

> [!WARNING]
> Syncline is pre-release. It is not on npm yet, and breaking changes can land without migrations.

## Features

- **Local first.** Reads and writes never wait for the network.
- **Plain Drizzle.** Declare tables with Drizzle once and use them on the device and in the cloud.
- **Live queries.** Queries re-run when the tables they read change.
- **No lost writes.** Network drops, retries, and crashes never lose a write or apply it twice.
- **iOS, Android, and web.** One API on every platform.
- **Cheap to run.** One Durable Object per user. Idle connections are not billed for duration.
- **Shared data.** Data the cloud writes for many users downloads through the CDN; each device gets only the parts its token allows.

## When not to use Syncline

- **Several people editing the same text.** When two devices change the same column, the write reaching the cloud last wins. Use a CRDT such as [Yjs](https://yjs.dev) for that.
- **Files and binary data.** BLOB columns are not supported, and rows have a size limit.
- **A backend other than Cloudflare.** The cloud side runs only on Durable Objects.
- **Devices writing shared data.** Devices only read shared spaces; the cloud writes them.
- **Expo Go.** Syncline needs a development build.

See [Limits](docs/reference/limits.md) for the full list.

## Quick start

### 1. Install

Syncline's `postinstall` script is for its own development. pnpm refuses to install until you decide on it, so first turn it off in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  syncline: false
```

Then install the latest release from GitHub, with the Drizzle and TanStack Query versions it works with:

```sh
pnpm add "github:hht/syncline#semver:*" drizzle-orm@1.0.0-rc.4 @tanstack/react-query@5
```

Keep the quotes, so your shell passes `*` through. To pin a [release](https://github.com/hht/syncline/releases), use `#v<version>` instead of `#semver:*`. `drizzle-orm` must be exactly the version above.

The package ships TypeScript source whose imports end in `.ts`. So that `tsc` accepts them, set `"allowImportingTsExtensions": true` in your `tsconfig.json`. Its cloud code uses ES2024 APIs, so your Worker's `tsconfig.json` needs `es2024` or later in `lib`. For Jest, add `syncline` to `transformIgnorePatterns`.

Your app also needs `expo` and `react`, in the versions under [Requirements](docs/reference/limits.md#requirements). Then wrap your Metro config:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withSyncline } = require('syncline/metro');

module.exports = withSyncline(getDefaultConfig(__dirname));
```

<details>
<summary>Build requirements</summary>

- Node.js 26 or later.
- iOS and Android need a [development build](https://docs.expo.dev/develop/development-builds/introduction/). Expo Go is not supported.
- The first iOS build, Android build, and Metro start download Syncline's prebuilt binaries from its GitHub release, so they need access to `github.com` and `release-assets.githubusercontent.com`. Behind a proxy, set `NODE_USE_ENV_PROXY=1` so Node uses `HTTPS_PROXY`.

</details>

### 2. Declare your tables

Share one schema between the app and the cloud:

```ts
// schema.ts
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const note = sqliteTable('note', {
  id: text().primaryKey(),
  body: text().notNull(),
});

export const schema = { note };
```

### 3. Set up the cloud

Create a Durable Object class for user data, and a Worker that checks the token:

```ts
// worker.ts
import { forward, SynclineSpace } from 'syncline/cloudflare';
import { schema } from './schema';

export class UserSpace extends SynclineSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, schema);
  }
}

export default {
  // Return { space: userID, expiresAt } (epoch milliseconds), or undefined to reject the token.
  fetch: (request: Request, env: Env) =>
    forward(request, env.USER_SPACE, async (token) => verifyToken(token)),
};
```

Register the class in `wrangler.jsonc`:

```jsonc
{
  "name": "my-sync",
  "main": "worker.ts",
  "compatibility_date": "2026-09-30",
  "durable_objects": { "bindings": [{ "name": "USER_SPACE", "class_name": "UserSpace" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["UserSpace"] }]
}
```

Allow Wrangler's build scripts by adding `esbuild: true` and `workerd: true` under `allowBuilds`, install it with `pnpm add -D wrangler`, and run `npx wrangler types` to generate the `Env` type. Run `npx wrangler dev` to try it locally, or `npx wrangler deploy` to ship it.

### 4. Use it in your app

```tsx
import { randomUUID } from 'expo-crypto';
import { Button, Text, View } from 'react-native';
import { openSyncline } from 'syncline/expo';
import { SynclineProvider, useQuery, useSyncline } from 'syncline/react';
import { schema, note } from './schema';

const syncline = openSyncline({
  name: 'app',
  userID,
  schema,
  url: 'https://api.example.com/sync',
  token: getIdToken,
});

export function App() {
  return (
    <SynclineProvider value={syncline}>
      <Notes />
    </SynclineProvider>
  );
}

function Notes() {
  const { data } = useQuery((db) => db.select().from(note));
  const { write } = useSyncline();
  const add = () => write(async (tx) => tx.insert(note).values({ id: randomUUID(), body: 'Hello' }));
  return (
    <View>
      {data?.map(({ id, body }) => (
        <Text key={id}>{body}</Text>
      ))}
      <Button title="Add" onPress={add} />
    </View>
  );
}
```

The sample makes IDs with `expo-crypto`; any unique string works.

`SynclineProvider` must sit inside TanStack Query's `QueryClientProvider`.

Against `wrangler dev`, add `allowCleartext: true` and use:

- `http://localhost:8787` from the iOS simulator or a browser
- `http://10.0.2.2:8787` from the Android emulator
- your computer's LAN address from a phone, after starting `npx wrangler dev --ip 0.0.0.0`

Open the app on two devices. Add a note on one, and it shows up on the other.

## Documentation

Guides:

- [Shared spaces](docs/guides/shared-spaces.md): set up data the cloud writes for many users, from the Worker to the app.
- [Bucket rules](docs/guides/bucket-rules.md): decide which rows each user downloads.
- [Bulk writes](docs/guides/bulk-writes.md): import large amounts of data into a shared space.
- [Testing](docs/guides/testing.md): test the cloud side with Vitest.
- [Exports](docs/guides/exports.md): copy private spaces into another database.
- [Upgrading the cloud](docs/guides/upgrading.md): what carries over between releases, and how to rebuild a space.

Reference:

- [Limits](docs/reference/limits.md): what Syncline does not support, and what happens past each limit. Read it before you design your schema.
- [Errors](docs/reference/errors.md): what each error means and how to handle it.
- [FAQ](docs/reference/faq.md): common questions.
- [API](docs/reference/api.md): every export and option.

## License

[Apache License 2.0](LICENSE)
