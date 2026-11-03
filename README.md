# Syncline

Syncs relational SQLite tables between Expo devices (iOS, Android, web) and Cloudflare. Reads and writes run against the local database on device without waiting for the network; the cloud is the single source of truth.

- **Local-first**: The UI reads and writes local SQLite, works offline as usual, and syncs automatically when online.
- **Standard Drizzle**: Define tables with Drizzle and write queries as usual; queries reading those tables automatically refresh when data changes.
- **One Durable Object per user**: Uses Durable Object SQLite on the cloud with hibernatable WebSockets that incur no duration charges while idle.
- **Shared data over CDN**: Shared data (such as catalogs) downloads by subscription (a set of buckets); devices with identical subscriptions share edge cache entries, letting millions of devices load data from a single computation at the origin.
- **Zero data loss on errors**: Writes that fail cloud execution are held intact for inspection and can be resubmitted after fixes; network drops, duplicates, out-of-order delivery, and crashes never lose writes or execute them twice. The protocol is modeled in TLA+ and exhaustively checked with TLC.

## How it works

Local writes take effect immediately and are recorded in pending writes. The cloud executes writes in sequence, records one version per commit, and pushes changes and confirmations back to each online device. When a device receives an update, it reverts unconfirmed writes, applies the cloud changes, and replays unconfirmed writes on top. As a result, the UI always observes cloud data plus its own unconfirmed local writes.

## Install

Not yet published to a package registry. Reference it via a local directory path (pnpm links it into `node_modules`, resolving dependencies and peer dependencies against the app; run `pnpm install` again in the app after modifying Syncline):

```json
{ "dependencies": { "syncline": "file:../syncline" } }
```

The package entrypoints export TypeScript source directly: Metro and wrangler bundle it as usual. For Jest, add `syncline` to `transformIgnorePatterns`. Its `postinstall` script is only for internal development; set `syncline: false` under `allowBuilds` in `pnpm-workspace.yaml`.

The app also requires `expo`, `react`, and `@tanstack/react-query`. Wrap the Metro configuration with `withSyncline`:

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withSyncline } = require('syncline/metro');
module.exports = withSyncline(getDefaultConfig(__dirname));
```

The device runtime is written in Rust (native modules on iOS and Android requiring a development build; WebAssembly on web), compiled at build time. Install rustup (toolchain version specified in `rust/rust-toolchain.toml`). When Metro starts, it builds the web WebAssembly bundle (even when running only mobile targets), which requires LLVM installed via mise (see `src/build-wasm.mjs` for the version; prints installation commands if missing) and the wasm-bindgen CLI (matching the `wasm-bindgen` version in `rust/Cargo.toml`). Android also requires `cargo-ndk`. The cloud runtime runs on Cloudflare Workers with Durable Objects backed by SQLite storage.

## At a glance

The cloud and devices share the same Drizzle table definitions:

```ts
export const schema = { workout: sqliteTable('workout', { id: text().primaryKey(), title: text().notNull() }) };
```

Cloud: Extend `SynclineSpace`. The entry Worker verifies the token and forwards the request.

```ts
import { forward, SynclineSpace } from 'syncline/cloudflare';

export class UserSpace extends SynclineSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, schema);
  }
}

export default {
  fetch: (request: Request, env: Env) => forward(request, env.USER_SPACE, async (token) => lookUp(token)), // → { space: userId, expiresAt }
};
```

App: Open the database, pass it to React, and read and write with hooks.

```tsx
import { openSyncline } from 'syncline/expo';
import { SynclineProvider, useQuery, useSyncline } from 'syncline/react';

const space = openSyncline({ name: 'app', owner: uid, schema, url: 'https://api.example.com/sync', token: getIdToken });

<SynclineProvider value={space}>…</SynclineProvider>;

function Workouts() {
  const { data } = useQuery((db) => db.select().from(workout)); // Automatically refreshes when read tables change
  const { write } = useSyncline();
  const add = () => write(async (tx) => tx.insert(workout).values({ id: crypto.randomUUID(), title: 'squat' }));
  // …
}
```

## What else it does

| Feature | Summary |
|---|---|
| Live queries | Re-runs queries when read tables change, powered by TanStack Query |
| Foreign keys and validation | Cascades deletes to child rows and validates full rows on write using identical rules on both ends |
| Local-only tables | Unsynced tables created in the same database, queryable and writable alongside synced tables |
| Server writes | Cloud-side mutations on user data pushed immediately to online devices |
| Read-only tables | Server-writable tables (billing, trials) that devices cannot modify; modifications from modified clients are held |
| Sync status | Connection state, download progress, and pending write counts; manual sync and resync |
| Held writes | Stores writes that failed cloud execution intact, notifies the user, and resubmits them once repaired |
| Schema evolution | Automatically creates tables and adds columns from Drizzle schemas; deploy cloud first, un-upgraded apps continue syncing; app upgrades do not redownload data; adding tables or columns re-downloads only the modified table |
| Shared spaces | Server-written data shared across users, downloaded over CDN and pushed live through broadcast shards |
| Web | Same API with the local database on OPFS and sync running in Syncline's dedicated Web Worker |
| Exports | Streams per-user mutations to external destinations for cross-user analytics |
| Point-in-time recovery | Restores a user's data to any bookmark within the last 30 days |
| Observability | Dispatches cloud events to your logging and alerting infrastructure |

## Documentation

Reference: [API](docs/reference/api.md), [Limits](docs/reference/limits.md). Protocol verification: [Models and model checking](docs/internals/model.md); design trade-offs: [Architecture decisions](docs/internals/adr.md).
