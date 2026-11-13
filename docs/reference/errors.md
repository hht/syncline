# Errors

English | [简体中文](zh-CN/errors.md)

Syncline recovers from network and cloud failures on its own, keeping pending writes until the cloud confirms them. When a failure needs a decision, sync stops or the write is held, and Syncline tells your app.

## On the device

### Where errors show

- `openSyncline` throws for mistakes in your options or table declarations.
- `waitForReady()` rejects when the database cannot open.
- `write()` rejects when a write breaks a rule. The whole transaction rolls back.
- `status()` and `onStatus` show `downloadError`, `uploadError`, and `updateNeeded`.
- `sync()` rejects with the same error the status shows, or with `signal.reason` when you abort it. Only `PendingWritesError` and `AccountMismatchError` can be checked with `instanceof`.
- `onHeld` reports writes the cloud refused to run.

The app's error handler (`reportError` on web, `ErrorUtils` on iOS and Android) receives:

- Errors thrown inside your `onStatus`, `onChange`, or `onHeld` listeners.
- Problems Syncline works around on its own, such as local data that did not match the cloud and was downloaded again, a downloaded value the local column cannot hold, or a failed background sync.

Sync goes on. Log these errors.

### Handled for you

| What happens | What the device does |
|---|---|
| Offline, or the connection drops or stalls | Retries with backoff and uploads pending writes once back |
| `token` throws, returns `undefined` or `null`, or takes more than 30 seconds | Sets `downloadError` and retries with backoff |
| The cloud rejects the token (HTTP 401) | Sets `downloadError` and retries with backoff |
| The token expires | Gets a new token and reconnects |
| The cloud closes the connection | Depends on the code; see [Connection errors](#connection-errors) |

For these, show `downloadError` or `uploadError` to the user if you want; there is nothing to fix in your code. A token your cloud keeps rejecting is the exception: check `verify`. When the user signs out, call `close()` instead of throwing from `token`, or the device keeps retrying.

### Connection errors

The cloud closes a connection with codes such as these. Devices handle them on their own. Except for 4000, 4002, and 4003, the code shows in `uploadError` or `downloadError`.

| Code | Meaning | What the device does |
|---|---|---|
| 4000 | The device must download first | Downloads, then reconnects |
| 4001 | Token expired | Gets a new token and reconnects |
| 4002 | App and cloud versions differ | Stops if the cloud is newer (`updateNeeded`), else retries |
| 4003 | App and cloud schemas differ | Checks compatibility, then connects, stops (`updateNeeded`), or retries |
| 1007 | Cloud rejected a batch of uploaded writes (unreadable, or past a limit) | Stops uploading; see [`uploadError` shows code 1007](#uploaderror-shows-code-1007) |
| 1008 | Too many connections | Retries within 30 seconds |
| 1011 | Cloud failed to store the upload | Retries |
| 1013 | Upload quota reached | Retries later |
| 1003 | Binary message, or an upload to a shared space | Retries |

### A write throws

`write()` rejects and nothing is saved. Causes:

- `ValidationError`: a value breaks its column declaration (non-null, enum, length, JSON, a boolean other than 0 or 1, Infinity in a real column) or your `validation` schema, or the primary key is too long. `issues` lists the fields and reasons.
- A value its column cannot hold, such as text that is not a number, or a fraction, in an integer column. SQLite refuses it with its own error, not `ValidationError`.
- A [value](limits.md#values) or [write](limits.md#size) past a limit, such as invalid text, NaN, or too many rows.
- A row that references a missing row through a foreign key.
- A write to a `readOnly` table.

Fix the data and write again.

### A write appears, then disappears

The cloud refused to run it, for example because it broke a [limit](limits.md) or a rule in your cloud code. The cloud holds the write instead of dropping it.

Listen with `onHeld` to show the user what failed. It reports each held write at most once, when the cloud confirms that write to this device, so a write whose confirmation a background `syncOnce` received is never reported to it. The cloud keeps the full list; see [Held writes](#held-writes).

### `waitForReady()` rejects

The database could not open. `downloadError` shows the same error, and `sync()` and `resync()` reject with it. Causes:

- A declaration that does not match the stored database, such as a changed column type. See [Schema](limits.md#schema).
- `PendingWritesError` or another tab, below.
- An invalid `url`.

On iOS and Android, a failed open closes the database, except after an invalid `url`: call `close()` before opening it again.

A shared space differs: `openShared()` creates its tables in the background, so a declaration that does not match leaves its `waitForReady()` resolved. The failure shows in its `downloadError` while it retries.

### `PendingWritesError` when opening the database

The previous user still has writes waiting to upload, and opening for a new `userID` would delete them.

Ask the previous user to sign in again and sync. To drop their writes instead, open with `discardPending: true`.

### `AccountMismatchError` in `downloadError`

The cloud reports a different account than the one this database first synced with. Sync stops so nothing uploads to the wrong account. Reopen the database with the current user's `userID`.

### `updateNeeded` is true

The cloud is newer than the app, or the app uses a table or column the cloud has retired. Sync pauses. Ship an app update.

### `downloadError` says to wait for cloud deployment

The app is ahead of the cloud. Sync retries with backoff, and pending writes are kept. Causes:

- The app declares a table or column the cloud does not have, or declares differently, such as with another type or key. Deploy the cloud with it.
- The cloud runs an older Syncline release than the app. Deploy the cloud with the app's release.
- The cloud dropped a table or column without retiring it, so the wait never ends. List it in `retired` on both sides. For a rollback of both sides, see [Rolling back both sides after a column was added stops syncing](edge-cases.md#rolling-back-both-sides-after-a-column-was-added-stops-syncing).

### `uploadError` shows code 1007

The cloud rejected a batch of uploaded writes: it could not read it, or the batch broke a limit. Uploads stop until the app restarts or calls `resync()`. If the writes can never succeed, `resync({ discardPending: true })` drops them.

### The web app works in one tab only

Only one tab per site can open the database, and it keeps it until it closes or reloads. A second tab fails with an error starting with `Local database is open in another tab`: its `waitForReady()` rejects and `downloadError` shows the error. Close the other tab, then reload this one.

### Rare errors

Some errors take a mistake or an unusual release sequence, so most apps never meet them, such as [downloads that keep failing after adding a trigger](edge-cases.md#a-trigger-that-raises-an-error-can-block-downloads) or [a change to Syncline's own tables](edge-cases.md#a-pending-write-that-cannot-be-read-back-stops-the-device). See [Edge cases](edge-cases.md).

## In the cloud

### Held writes

A pushed write that fails to run is held, not dropped. The device keeps syncing.

In a method of your `SynclineSpace`:

1. List held writes with `held()`. Each has its `reason` and the original `changes`.
2. Fix the cause: your cloud code, a rule, or the data.
3. Call `resubmit(client, id)` to run it again, pass new `changes` to replace it, or pass `[]` to discard it.

### Errors in your cloud code

- `SynclineSpace` and `SynclineSharedSpace` throw when the schema breaks a rule that [Schema](limits.md#schema) says the cloud checks.
- `SynclineSharedSpace` also throws when reached without a name, or with a name too long for its shards (see [Shared spaces](limits.md#shared-spaces)).
- `mutate()` throws and rolls back when the write breaks a rule, such as a [limit](limits.md#size) or `ValidationError`.
- `forward` and `forwardShared` throw when `verify` returns a value they cannot use, such as an `expiresAt` that is not a finite number or a bucket that breaks your rules. The device's request fails: `downloadError` shows it and the device retries with backoff.
- An error thrown by your `scheduled(name)` goes to `reportError`, and the task is not run again. Call `schedule` inside it to retry.
- A task of yours that keeps resetting the object pauses, and the failure goes to `reportError` (see [A task that keeps resetting the object pauses for a day](edge-cases.md#a-task-that-keeps-resetting-the-object-pauses-for-a-day)).

### Events

Pass `onEvent` to `SynclineSpace`, `SynclineSharedSpace`, or `SynclineBroadcast` to log events or raise alerts. It receives a `SynclineEvent`. Keep the callback fast. An error it throws goes to `reportError` and does not affect sync.

Alert on these:

| Event | Meaning | What to do |
|---|---|---|
| `write.held` | A pushed write failed and is held | See [Held writes](#held-writes) |
| `push.failed` | An upload could not be read (the device gets 1007) or stored (the device retries) | Read `reason`. A space past its [storage limit](limits.md#cloud-storage) keeps failing |
| `export.failed` | An exporter failed. It is retried with backoff, and its destination falls behind | Fix the exporter or its destination |
| `upkeep.failed` | A background step failed, such as building an index. It is retried with backoff | Read `reason` if it keeps failing |
| `notice.failed` | A broadcast shard missed a live update. It is retried with backoff | Read `reason` if it keeps failing |
| `write.skipped` | A device skipped write IDs. This should not happen | [Open an issue](https://github.com/hht/syncline/issues) with the event |

These are for logs and metrics:

| Event | Meaning |
|---|---|
| `values.dropped` | A pushed write set retired tables or columns. Those values were dropped and the rest ran |
| `write.resubmitted` | A held write ran after `resubmit` |
| `schema.changed` | Tables or columns entered or left sync when the object started |
| `cookie.reset` | A device's position is not in the shared space's history, so it downloads everything again |
| `chunk.pulled` | A device downloaded a chunk of rows |
| `connection.closed` | The cloud closed a connection, with its code and reason |
