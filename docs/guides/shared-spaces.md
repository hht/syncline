# Shared spaces

English | [简体中文](zh-CN/shared-spaces.md)

A shared space holds data the cloud writes for many users. Each device downloads only the rows its token allows. Devices read shared spaces; only the cloud writes them.

This guide builds one from scratch. The code is taken from the [example Worker](../../examples/cloudflare), which runs under `wrangler dev` and has tests.

## How the pieces fit

A shared space needs four parts in your Worker:

| Part | What it does |
|---|---|
| `SynclineSharedSpace` | Durable Object holding the data. Your server writes go here. |
| `SynclineBroadcast` | Durable Objects that hold devices' live connections. The shared space spreads them over 16 of these by default (`shards`). |
| `SynclineSharedEntry` | Worker entrypoint that answers downloads. Workers Cache sits in front of it. |
| `forwardShared` | Called from your Worker's `fetch`. Checks the token, then sends live connections to a broadcast object and downloads to the entry. |

## 1. Define the space

Put the bucket rules in their own module, imported by both the Worker and the shared space Durable Object. Keep the tables in another module, which the app imports too.

```ts
export const shared = {
  schema: { document, revision, section },
  rules: {
    public: {
      document: { where: "status = 'published'" },
      revision: { where: "status = 'published'" },
      section: { where: "status = 'published'" },
    },
    admin: { document: {}, revision: {}, section: {} },
    team: { document: { by: ['team_id'] } },
    level: { document: { by: ['level'] } },
  },
} satisfies SharedDefinition;
```

- `schema` lists the tables devices receive.
- `rules` maps a rule name to the tables it covers. A row belongs to bucket `[rule, ...values of by]` when it matches `where` and none of its `by` columns is null.
- `where` reads only the columns of its own row. See [Bucket rules](bucket-rules.md) for what that means for related tables.

## 2. Map users to buckets

A token grants a list of buckets. Write one function that computes it:

```ts
/** Buckets a user may read: text columns take strings, integer columns take numbers. */
export function bucketsOf(user: User): Bucket[] {
  return [
    ['public'],
    ...(user.admin ? [['admin'] as Bucket] : []),
    ...user.teams.map((team): Bucket => ['team', team]),
    ['level', user.level],
  ];
}
```

A parameter must match its column's type exactly. Pass a string for a text column and a number for an integer column. `['level', '2']` does not match an integer column: `forwardShared` throws instead of quietly showing nothing.

Real and other column types cannot be bucket columns.

## 3. Write the three classes

```ts
export class SharedSpace extends SynclineSharedSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { ...shared, cloud, broadcast: (bindings) => bindings.SHARED_BROADCAST });
  }
```

`SynclineSharedSpace` takes the definition plus:

- `broadcast`: a function returning the broadcast namespace from `env`. The space sends each change to every broadcast object through it.
- `cloud`, `validation`, `retired`, `onEvent`: optional, as on `SynclineSpace`. See the [API](../reference/api.md#shared-spaces).

Add your own methods that call `this.mutate`. They are the only way to write.

```ts
export class SharedBroadcast extends SynclineBroadcast<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, env.SHARED_SPACE);
  }
}
```

`SynclineBroadcast` takes the shared space namespace. A broadcast object is named `<space name>#<n>`, and finds its shared space by the part before the last `#`.

```ts
export class SharedEntry extends SynclineSharedEntry<Env> {
  protected shared() {
    return this.env.SHARED_SPACE;
  }
}
```

`SynclineSharedEntry` needs only `shared()`, returning the shared space namespace.

## 4. Route requests in the Worker

```ts
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/shared') {
      const route = { entry: ctx.exports.SharedEntry, broadcast: env.SHARED_BROADCAST, space: 'shared', definition: shared };
      return forwardShared(request, route, async (token) => {
        const user = await verifyToken(token, env.TOKEN_SECRET);
        return user && { buckets: bucketsOf(user), expiresAt: user.expiresAt };
      });
    }
    if (pathname === '/sync')
      return forward(request, env.USER_SPACE, async (token) => {
        const user = await verifyToken(token, env.TOKEN_SECRET);
        return user && { space: user.id, expiresAt: user.expiresAt };
      });
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

`verifyToken` stands for your own token check. Return `undefined` to answer 401.

The `route` fields:

- **`entry`**: pass `ctx.exports.SharedEntry` itself. Don't pass `ctx.exports.SharedEntry.fetch`. Syncline calls it with the subscription as props, and calling `.fetch(request, { props })` loses them. The entry then throws `SynclineSharedEntry received no props`.
- **`broadcast`**: the broadcast namespace.
- **`space`**: the name of the shared space Durable Object. Use a fixed name. Your server writes must reach the same name: `env.SHARED_SPACE.getByName('shared')`. Different names are separate spaces.
- **`definition`**: the same object the space was built with.

The space name, plus `#15` with the default shards, must fit in 1,024 bytes. Reach the space only by name (`getByName` or `idFromName`). An ID from `newUniqueId` or `idFromString` makes it throw.

Private and shared spaces share one Worker. Route by path, as above.

## 5. Configure wrangler

```jsonc
  "durable_objects": {
    "bindings": [
      { "name": "USER_SPACE", "class_name": "UserSpace" },
      { "name": "SHARED_SPACE", "class_name": "SharedSpace" },
      { "name": "SHARED_BROADCAST", "class_name": "SharedBroadcast" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["UserSpace", "SharedSpace", "SharedBroadcast"] }],
```

Create every class with `new_sqlite_classes`. `SynclineBroadcast` stores nothing but its alarm and connections, but Cloudflare [recommends SQLite storage](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/) for all new classes, and the Free plan offers only SQLite.

Then turn on Workers Cache for the entry, and only for the entry:

```jsonc
  "cache": { "enabled": true },
  "exports": {
    "default": { "type": "worker", "cache": { "enabled": false } },
    "SharedEntry": { "type": "worker", "cache": { "enabled": true } }
  }
```

Workers Cache sits in front of every entrypoint once enabled, including the default one. See [Cloudflare's example](https://developers.cloudflare.com/workers/cache/examples/).

| If you leave out | What happens |
|---|---|
| `cache` | Nothing is cached. Every download reaches the shared space Durable Object, and is billed as such. |
| `"default"` with `enabled: false` | Every request to your Worker first looks up the cache. `forwardShared` marks its own responses `no-store`, so they are not kept, but any other route of yours answering 200 without `Cache-Control` is cached for 2 hours and served without running your code. |

Workers Cache needs Wrangler 4.69.0 or later; per-entrypoint `exports` need 4.107.0 or later ([configuration](https://developers.cloudflare.com/workers/cache/configuration/)).

## 6. Open the space in the app

Import the shared tables into the app from a module without cloud code. The example keeps them in [`examples/cloudflare/tables.ts`](../../examples/cloudflare/tables.ts), apart from the rules.

```ts
  const shared = syncline.openShared('shared', {
    schema: { document, revision, section },
    url: 'https://api.example.com/shared',
    userID,
  });
```

- **`name`** (first argument): the local name of this space. Each shared space needs its own.
- **`url`**: the path routed to `forwardShared`.
- **`token`**: optional. Leave it out to use the private space's `token`.
- **`userID`**: the signed-in user. When it differs from last time, the device clears the rows the previous user saw before any later query runs. Without it, nothing is cleared when the space opens.

Query the shared tables through `syncline.db` like any other table.

### When permissions change

Call `reconnect()` on the shared space when a user's access changes, for example in Firebase's `onIdTokenChanged`. Each space reconnects on its own: `syncline.reconnect()` reconnects only the private space.

```ts
  onTokenChanged(() => {
    syncline.reconnect();
    shared.reconnect();
  });
```

Downloads check the token every time. A live connection keeps the old buckets until it reconnects. Without `reconnect()`, live updates follow the old access until at most a minute after the old token expires.

Adding buckets downloads only the new buckets. Removing buckets downloads everything again; the old rows stay visible until that lands.

## 7. Develop locally

- Pass `allowCleartext: true` to `openSyncline`. It applies to shared spaces too.
- Use the same addresses as in the [README](../../README.md#4-use-it-in-your-app).
- Workers Cache does not answer requests under `wrangler dev` (4.158.0) or in Vitest (`@cloudflare/vitest-plugin` 1.6.0). Every download reaches the Durable Object, so local runs show no caching effects. Once deployed, the `cf-cache-status` response header shows `HIT` for downloads the cache answered.

## Next

- [Bucket rules](bucket-rules.md): modeling who sees what.
- [Bulk writes](bulk-writes.md): importing large amounts of data.
- [Testing](testing.md): testing the cloud side with Vitest.
