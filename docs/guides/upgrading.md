# Upgrading the cloud

English | [简体中文](zh-CN/upgrading.md)

What happens to existing spaces when you deploy a new Syncline release, and how to rebuild a space you cannot upgrade.

## What carries over

Syncline keeps its own tables in every space's storage, next to yours. A deploy upgrades them in place the first time each space starts.

- **Releases from v0.1.0 on:** every space they created keeps working after you deploy a later release. Changes to Syncline's own tables are only ever added as new upgrade steps.
- **Rolling back:** deploying an earlier release from v0.1.0 on undoes the steps that release doesn't know.
- **Before v0.1.0:** spaces created by unreleased versions are not supported. Rebuild them.

Your own tables follow your schema, as described in the [FAQ](../reference/faq.md#how-do-i-change-my-schema).

## Spotting a space from before v0.1.0

Writes and downloads still work, but every alarm fails with `no such column: resets` before running anything. Exports, background cleanup, and your own `schedule` callbacks stop.

## Rebuilding

Rebuilding deletes all data in the space. Copy out anything you need first, and write it back afterwards: see [Bulk writes](bulk-writes.md).

Devices download a rebuilt shared space from scratch on their own. For about 60 seconds, new devices may get old data from the cache; the cloud then makes them download again.

### One shared space: use a new name

A shared space is reached by name, so a new name is a new, empty space:

1. Change `space` in `forwardShared`, and the name your server writes use, for example from `'shared'` to `'shared-2'`.
2. Deploy, then write the data into the new space.

The old object keeps its storage until you empty it.

### A whole class: two deploys

To rebuild every object of a class, delete the class and create it again. This takes two deploys, following Cloudflare's [class migrations](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/).

The steps below rebuild the shared space class. Its broadcast class is rebuilt with it, since each takes the other's binding, and broadcast objects keep no data to lose. To rebuild a private space class, list only that class.

**Deploy 1: delete.**

1. Remove both classes' bindings from `durable_objects`.
2. Remove everything that uses those bindings:
   - `SharedSpace` and `SharedBroadcast`.
   - `SharedEntry`, with its entry under `exports`.
   - The `/shared` route.
   - Anything else that calls the space, such as your server writes.
3. Add a migration with a new tag: `{ "tag": "v2", "deleted_classes": ["SharedSpace", "SharedBroadcast"] }`.
4. Deploy.

**Deploy 2: create.**

1. Restore everything deploy 1 removed.
2. Add another migration: `{ "tag": "v3", "new_sqlite_classes": ["SharedSpace", "SharedBroadcast"] }`.
3. Deploy.

Devices cannot reach the shared space between the two deploys.

Cloudflare requires the binding to be gone before a class is deleted, so deleting and creating cannot share one deploy. A deploy that tries fails with code 10061 (`Cannot apply --delete-class migration to class 'SharedSpace' without also removing the binding that references it`) and changes nothing.

If your Worker declares Durable Objects under `exports` instead of `migrations`, delete with `"state": "deleted"` instead. See [Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).
