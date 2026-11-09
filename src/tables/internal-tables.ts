import { queryOf, type Storage } from '../common/storage.ts';

/**
 * Internal schema and migration steps for cloud SQLite storage.
 * Version steps track schema evolutions, storing down statements to support rollbacks when cloud workers revert to earlier deployments.
 * Migrations execute inside a single transaction and use internal tracking tables rather than PRAGMA user_version.
 * @see https://github.com/powersync-ja/powersync-sqlite-core/blob/main/crates/core/src/migrations.rs
 */

// Migration step: up statements to advance from previous version, down statements to revert.
type Step = { up: string[]; down: string[] };

/** Migration steps ordered by 1-based version number; a released step never changes, later releases only append. */
export const steps: Step[] = [
  {
    up: [
      // Commit log: tracks modified primary keys per commit; bytes records cumulative primary key UTF-8 bytes to compute delta sizes without scanning.
      // day and used track daily write quotas; client records the client ID for pushed writes.
      'CREATE TABLE _syncline_commit (version INTEGER PRIMARY KEY, nonce INTEGER NOT NULL, keys TEXT NOT NULL, day INTEGER, used INTEGER, bytes INTEGER NOT NULL, client TEXT)',
      // Version 0 (empty database): random 53-bit nonce generated on space creation to distinguish rebuilt spaces and invalidate obsolete cookies.
      "INSERT INTO _syncline_commit (version, nonce, keys, bytes) VALUES (0, abs(random() % 9007199254740992), '[]', 0)",
      // Space incarnation (used by shared spaces): stores version 0 nonce permanently across log truncation.
      'CREATE TABLE _syncline_incarnation (one INTEGER PRIMARY KEY CHECK (one = 1), nonce INTEGER NOT NULL)',
      'INSERT INTO _syncline_incarnation SELECT 1, nonce FROM _syncline_commit WHERE version = 0',
      // Log floor: latest truncated version, its nonce, and cumulative bytes after log truncation.
      'CREATE TABLE _syncline_low (one INTEGER PRIMARY KEY CHECK (one = 1), version INTEGER NOT NULL, nonce INTEGER NOT NULL, bytes INTEGER NOT NULL)',
      // Client table: records highest processed mutation ID (lmid) per client.
      'CREATE TABLE _syncline_client (client TEXT PRIMARY KEY, lmid INTEGER NOT NULL) WITHOUT ROWID',
      // Chunk boundary: records commit versions every chunkRows changed rows for shared spaces.
      'CREATE TABLE _syncline_boundary (version INTEGER PRIMARY KEY)',
      // Held writes: rejected client mutations stored for repair and resubmission.
      'CREATE TABLE _syncline_held (client TEXT NOT NULL, mutation_id INTEGER NOT NULL, part INTEGER NOT NULL, version INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, changes TEXT NOT NULL, PRIMARY KEY (client, mutation_id, part))',
      'CREATE INDEX _syncline_held_version ON _syncline_held (part, version)',
      // Synced tables and columns, retired names, and retirement timestamps.
      'CREATE TABLE _syncline_synced (tbl TEXT NOT NULL, col TEXT NOT NULL, PRIMARY KEY (tbl, col)) WITHOUT ROWID',
      'CREATE TABLE _syncline_retired (name TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID',
      // Scope table: records the commit version (since) when each table entered sync or modified columns.
      'CREATE TABLE _syncline_scope (tbl TEXT PRIMARY KEY, since INTEGER NOT NULL) WITHOUT ROWID',
      // Canonical bucket rule definitions per table for detecting rule modifications.
      'CREATE TABLE _syncline_rules (tbl TEXT PRIMARY KEY, definition TEXT NOT NULL) WITHOUT ROWID',
      // Bucket row counts per table generation and cursor progress for background row counting.
      'CREATE TABLE _syncline_bucket_rows (tbl TEXT NOT NULL, gen INTEGER NOT NULL, bucket TEXT NOT NULL, rows INTEGER NOT NULL, PRIMARY KEY (tbl, gen, bucket)) WITHOUT ROWID',
      'CREATE TABLE _syncline_counted (tbl TEXT PRIMARY KEY, gen INTEGER NOT NULL, after TEXT) WITHOUT ROWID',
      // Schedule table multiplexing background chores and timers onto alarms; resets counts runs started but never finished.
      'CREATE TABLE _syncline_schedule (name TEXT PRIMARY KEY, at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, resets INTEGER NOT NULL DEFAULT 0)',
    ],
    down: [],
  },
];

/** Migrates internal metadata tables up or down to match the expected version. */
export function prepareInternalTables(storage: Storage) {
  const query = queryOf(storage);
  storage.transactionSync(() => {
    query('CREATE TABLE IF NOT EXISTS _syncline_schema (version INTEGER PRIMARY KEY, down TEXT NOT NULL)');
    for (const { down } of query('SELECT down FROM _syncline_schema WHERE version > ? ORDER BY version DESC', steps.length))
      for (const sql of JSON.parse(String(down)) as string[]) query(sql);
    query('DELETE FROM _syncline_schema WHERE version > ?', steps.length);
    const current = Number(query('SELECT ifnull(max(version), 0) AS version FROM _syncline_schema')[0]?.version);
    for (const [offset, { up, down }] of steps.slice(current).entries()) {
      for (const sql of up) query(sql);
      query('INSERT INTO _syncline_schema VALUES (?, ?)', current + offset + 1, JSON.stringify(down));
    }
  });
}
