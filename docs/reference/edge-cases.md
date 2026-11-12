# Edge cases

English | [简体中文](zh-CN/edge-cases.md)

Rare situations. Each takes an unusual release sequence, a mistake, a platform fault, or an extreme size, so most apps never meet them. More are listed under [Edge cases](limits.md#edge-cases) in Limits.

## Devices

### A token with 4 minutes or less left is not renewed early

A device reconnects for a new token between 1 and 4 minutes before its token expires, but only when the token had more than 4 minutes left as the device connected.

A token with 4 minutes or less left is used until it expires. The cloud then closes the connection with code 4001, which shows in `downloadError`, and the device reconnects with a new token. A shared space closes the connection within a minute of the expiry; a private space closes it at its next change or upload.

Nothing is lost. To keep the code out of `downloadError`, have `token` return tokens with more than 4 minutes left.

### Dropping pending writes can clear the synced tables

`resync({ discardPending: true })` undoes the pending writes at once and keeps the other rows visible until the download lands.

If a pending write cannot be undone, Syncline clears the synced tables instead and reports why to the app's error handler. The download then fills them again. A write cannot be undone when synced tables were changed outside Syncline, or when a trigger of yours raises an error: see App triggers under [Things to know](limits.md#things-to-know).

### Names that differ only by case are one name

Table names ignore case, as in SQLite. That holds across `schema`, `localOnly`, the schemas of shared spaces, and `retired`, on devices and in the cloud:

- Two tables whose names differ only by case cannot both be declared.
- A name that differs from a retired name only by case is that retired name, so it cannot be declared.
- A table must be declared under the case it is stored as. Otherwise opening fails on a device, a shared space shows the failure in its `downloadError`, and the object throws in the cloud.
- A name in `retired` matches the stored table or column whatever its case.

Keep the spelling a table was first created with.

## Shared spaces

### Switching users clears a shared space even when it then fails to open

`openShared` with another `userID` than last time clears the rows the previous user saw, before any query made after the call runs. It does so even if the space then fails to open, such as after a release changed a column type, so those rows never stay readable.

The rows stay only when the declaration itself is refused, such as a table name another space uses or a retired name.

## Cloud

### A cloud-only column of an unusual type fails on existing tables

A cloud-only column declared as `text()`, `integer()`, `real()`, or `blob()`, in any mode, can be added at any time.

Other declarations, such as `text({ length: 40 })` or `numeric()`, work only in a table created with them. Added to an existing table, such a column makes the object throw when it starts. So does a synced `text({ length })` column kept as cloud-only after it leaves the schema.

A newly created space accepts the same declaration, so it can pass local development and fail once deployed. Declare the column with one of the four types above.
