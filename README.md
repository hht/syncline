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

## Quick start

### 1. Install

Install the latest release from GitHub:

```sh
pnpm add github:hht/syncline
```

Append `#v<version>` to pin a [release](https://github.com/hht/syncline/releases).

Syncline's `postinstall` script is for its own development. pnpm refuses to install until you decide on it, so turn it off in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  syncline: false
```

For Jest, add `syncline` to `transformIgnorePatterns`: the package ships TypeScript source.

Your app also needs `expo`, `react`, `@tanstack/react-query`, and `drizzle-orm` 1.0.0-rc.4. Then wrap your Metro config:

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

Run `npx wrangler dev` to try it locally, or `npx wrangler deploy` to ship it.

### 4. Use it in your app

```tsx
import { randomUUID } from 'expo-crypto';
import { openSyncline } from 'syncline/expo';
import { SynclineProvider, useQuery, useSyncline } from 'syncline/react';
import { schema, note } from './schema';

const space = openSyncline({
  name: 'app',
  userID,
  schema,
  url: 'https://api.example.com/sync',
  token: getIdToken,
});

export function App() {
  return (
    <SynclineProvider value={space}>
      <Notes />
    </SynclineProvider>
  );
}

function Notes() {
  const { data } = useQuery((db) => db.select().from(note));
  const { write } = useSyncline();
  const add = () => write(async (tx) => tx.insert(note).values({ id: randomUUID(), body: 'Hello' }));
  // Render data and call add()
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

- [Limits](docs/reference/limits.md): what Syncline does not support, and what happens past each limit. Read it before you design your schema.
- [FAQ](docs/reference/faq.md): common questions and errors.
- [API](docs/reference/api.md): every export and option.
