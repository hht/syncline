# FAQ

English | [简体中文](zh-CN/faq.md)

## Using Syncline

### Does the app work offline?

Yes. Reads and writes go to the local database. Writes upload when the device is back online.

### What happens when two devices edit the same row?

The cloud applies writes column by column, in the order they arrive. If both devices change the same column, the later write wins. Changes to different columns are both kept.

### How do I know sync has finished?

Call `await space.sync()`. It resolves once the device is up to date and the cloud has confirmed every local write.

For a live indicator, read `status()` or subscribe with `onStatus`. `status().pending` is the number of writes not yet confirmed.

### How do I change my schema?

Deploy the cloud first, then ship the app.

- **Add a table or column:** declare it on both sides. Devices download that table again.
- **Remove a table or column:** list it in `retired` on both sides. Never reuse a retired name.

Apps that have not updated keep syncing after you add tables or columns. After you retire one they still use, they stop with `updateNeeded` until they update.

### How do I share data between users?

Use a shared space. The cloud writes the data, and each device downloads the parts its token allows. See `openShared()` in the [API](api.md).

### Can the app sync in the background?

Yes, on iOS and Android. Use `defineBackgroundSync` and `startBackgroundSync` from `syncline/expo/background`.

### Can I use Expo Go?

No. Syncline needs a [development build](https://docs.expo.dev/develop/development-builds/introduction/).

### How do I connect to `wrangler dev`?

Pass `allowCleartext: true` to `openSyncline`, and use `http://localhost:8787` from the iOS simulator or a browser, or `http://10.0.2.2:8787` from the Android emulator. From a phone, start `npx wrangler dev --ip 0.0.0.0` and use your computer's LAN address. Use `https://` everywhere else.

## Errors

### A write appears, then disappears

The cloud refused to run it, for example because it broke a [limit](limits.md) or a rule in your cloud code. The cloud holds the write instead of dropping it.

Listen with `onHeld` to show the user what failed. Once the cause is fixed, resubmit or discard the write in the cloud with `resubmit`.

### `PendingWritesError` when opening the database

The previous user still has writes waiting to upload, and opening for a new `userID` would delete them.

Ask the previous user to sign in again and sync. To drop their writes instead, open with `discardPending: true`.

### `AccountMismatchError` in `downloadError`

The cloud reports a different account than the one this database first synced with. Sync stops so nothing uploads to the wrong account. Reopen the database with the current user's `userID`.

### `updateNeeded` is true

The cloud is newer than the app, or the app uses a table or column the cloud has retired. Ship an app update.

### `uploadError` shows code 1007

The cloud rejected a batch of uploaded writes: it could not read it, or the batch broke a limit. Uploads stop until the app restarts or calls `resync()`. If the writes can never succeed, `resync({ discardPending: true })` drops them.

### Downloads keep failing after I added a trigger

A trigger on a synced table that raises an error can block downloads, or opening the database. Remove the trigger, or stop it from raising when Syncline changes rows.

### The web app works in one tab only

Only one tab per site can open the database. Close the other tab, then reload this one.
