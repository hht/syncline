# FAQ

English | [简体中文](zh-CN/faq.md)

## Using Syncline

### Does the app work offline?

Yes. Reads and writes go to the local database. Writes upload when the device is back online.

### What happens when two devices edit the same row?

The cloud applies writes column by column, in the order they arrive. If both devices change the same column, the later write wins. Changes to different columns are both kept.

### How do I know sync has finished?

Call `await syncline.sync()`. It resolves once the device is up to date and the cloud has confirmed every local write.

For a live indicator, read `status()` or subscribe with `onStatus`. `status().pending` is the number of writes not yet confirmed.

### How do I sign a user out?

Upload the user's writes first, then close the database:

1. Stop making writes.
2. Call `await syncline.sync()`. If it rejects, `status().pending` is the number of writes not uploaded yet.
3. Call `await syncline.close()` and pass `undefined` to `SynclineProvider`. On iOS and Android, also call `stopBackgroundSync()`.

Opening the database for the next `userID` then clears this user's private data and local-only tables, keeping shared spaces. If writes are still pending, it fails with `PendingWritesError` and clears nothing. `delete()` removes the database at once, including writes not uploaded yet, without an error.

### How do I change my schema?

Deploy the cloud first, then ship the app.

- **Add a table or column:** declare it on both sides. Devices download that table again.
- **Remove a table or column:** list it in `retired` on both sides. Never reuse a retired name.

Apps that have not updated keep syncing after you add tables or columns. After you retire one they still use, they stop with `updateNeeded` until they update.

### How do I share data between users?

Use a shared space. The cloud writes the data, and each device downloads the parts its token allows. See the [shared spaces guide](../guides/shared-spaces.md), and `openShared()` in the [API](api.md).

### Can the app sync in the background?

Yes, on iOS and Android. Use `defineBackgroundSync` and `startBackgroundSync` from `syncline/expo/background`.

### Can I use Expo Go?

No. Syncline needs a [development build](https://docs.expo.dev/develop/development-builds/introduction/).

### How do I connect to `wrangler dev`?

Pass `allowCleartext: true` to `openSyncline`, and use `http://localhost:8787` from the iOS simulator or a browser, or `http://10.0.2.2:8787` from the Android emulator. From a phone, start `npx wrangler dev --ip 0.0.0.0` and use your computer's LAN address. Use `https://` everywhere else.

## Errors

See [Errors](errors.md) for what each error means and how to handle it.
