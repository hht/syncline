import { batchRows, commitFloor, readBytes, truncateBytes, truncateRows, valueBytes } from '../common/limits.ts';
import type { Cookie } from '../common/protocol.ts';
import { utf8Bytes } from '../common/size.ts';
import type { Query } from '../common/storage.ts';
import type { Key } from '../tables/keys.ts';
import { within } from './batches.ts';

/**
 * Records and queries commit log entries for a sync space.
 *
 * Each space maintains a single monotonically increasing version number. Every processed write records
 * a commit version containing touched rows ([table, key]) and a random nonce; sync scope changes
 * (dropped tables or columns) are also recorded here alongside data changes. Head versions and touched rows
 * after a given version are queried from this log.
 * Client mutation progress (lmid) is maintained separately in _syncline_client within the same transaction as
 * each client commit, queried by primary key independently of commit log size.
 * Pushed device commits record the client ID, allowing catch-up on connect to discover clients with commits
 * after the device cookie (lmidsSince).
 * The commit log is capped by byte size: truncation trims the oldest commits and records the new floor version's
 * nonce and cumulative bytes in _syncline_low; cookies at or above the floor remain on current history (Truncate in TLA+ models).
 * Operations execute within caller-provided transactions.
 * What it should not know: how row mutations execute or how pull chunks stream.
 * @see https://doc.replicache.dev/strategies/per-space-version
 * @see https://github.com/rocicorp/mono/blob/945ce619249e63381fb51d46c12f0d9e80024860/packages/zero-cache/src/services/mutagen/mutagen.ts
 */

/**
 * Single commit log item: a touched row [table, key] (canonical key representation; shared spaces optionally append bucket arrays [table, key, buckets]),
 * or a dropped table [table, null], or dropped columns [table, null, columns]. Entering tables, added columns, and bucket rule revisions
 * do not record items directly: the scope table records their starting version, which is committed as a keyless commit for pull scans.
 */
export type Entry = [string, Key] | [string, Key, string[]] | [string, null] | [string, null, string[]];
/** Touched items for a single commit. */
export type Keys = Entry[];

/** Returns the primary key of a touched row item, or undefined for dropped table/column entries. */
const rowKeyOf = ([, key]: Entry) => key ?? undefined;

/** Extracts touched rows [table, key] from commit entries, skipping dropped table/column entries. */
export const changedRows = (keys: Keys) =>
  keys.flatMap((entry): [string, Key][] => {
    const key = rowKeyOf(entry);
    return key ? [[entry[0], key]] : [];
  });
/** Cumulative rows written today (UTC calendar day) by device pushes, recorded on device commits. */
export type Used = { day: number; rows: number };

/** Generates a 53-bit integer random nonce representable accurately in JS numbers. */
const nonce = () => Number((crypto.getRandomValues(new BigUint64Array(1))[0] ?? 0n) >> 11n);

const keysOf = (keys: unknown) => JSON.parse(String(keys)) as Keys;

/** Converts client table rows into a client -> lmid map. */
const lmidsOf = (rows: Record<string, unknown>[]) => Object.fromEntries(rows.map(({ client, lmid }) => [String(client), Number(lmid)]));

/** Estimated byte overhead per commit log row excluding primary keys (columns, SQLite record header, cell pointer; device commits add client ID). */
export const rowOverhead = 72;

/** Maximum UTF-8 bytes for primary keys in a single commit log row (half the maximum single-value limit). */
const keysLimit = valueBytes / 2;

/** Stateful commit builder during write execution (begin on Commits): add appends an entry, finish commits the final segment. */
export type Recording = { add: (entry: Entry) => void; finish: (revise?: (keys: Keys) => Keys) => Cookie };

export class Commits {
  readonly #query: Query;
  readonly #chunkRows: number | undefined;
  readonly #floor: number;
  /** Changed rows accumulated after the last chunk boundary; computed lazily from database on first commit. */
  #open: number | undefined;

  /**
   * chunkRows: changed row threshold between chunk boundaries for shared spaces (undefined for private spaces);
   * floor: minimum commit log byte cap (defaults to commitFloor, reduced in tests).
   */
  constructor(
    query: Query,
    { chunkRows, commitFloor: floor = commitFloor }: { chunkRows?: number | undefined; commitFloor?: number | undefined } = {},
  ) {
    this.#query = query;
    this.#chunkRows = chunkRows;
    this.#floor = floor;
  }

  /** Returns the current incarnation nonce of version 0 (created on space initialization, distinct after rebuild for shared spaces). */
  incarnation() {
    const [row] = this.#query('SELECT nonce FROM _syncline_incarnation');
    if (!row) throw new Error('Missing space incarnation record in _syncline_incarnation; initialize the space before querying.');
    return Number(row.nonce);
  }

  /** Returns the latest commit cookie, or version 0 if no commits have been recorded. */
  head(): Cookie {
    return this.#cookie('SELECT version, nonce FROM _syncline_commit ORDER BY version DESC LIMIT 1');
  }

  /** Records a non-device commit from in-memory entries (e.g. dropped tables/columns, or empty array for keyless commits) and returns the resulting version. */
  record(keys: Keys) {
    const recording = this.begin(null, null);
    for (const entry of keys) recording.add(entry);
    return recording.finish().version;
  }

  /**
   * Begins recording a multi-segment commit during write execution.
   *
   * Appends touched rows via add. When accumulated primary keys exceed keysLimit bytes, a commit row is written
   * and the next segment begins, keeping memory footprint bounded regardless of write size.
   * For shared spaces, records a chunk boundary every chunkRows changed rows.
   * On committing the final segment, updates client lmid in _syncline_client within the caller's transaction.
   * Device cookies only land on the final segment (both pokes and final chunks carry the latest version); intermediate
   * segments appear only in pull cursors.
   * finish retrieves written segments to apply revise (validation, bucket assignment) and writes the final segment
   * (recording a keyless commit if empty, e.g. scope changes), rolling back entirely on error.
   * reserve specifies additional byte allowance per entry during revise, reserved during segment splitting.
   * used specifies cumulative daily written rows for device accounting.
   * Returns the final commit cookie (the new head).
   */
  begin(
    client: string | null,
    id: number | null,
    { used, reserve = 0 }: { used?: (() => Used) | undefined; reserve?: number } = {},
  ): Recording {
    // Computes open rows after the latest boundary before writing (calculating after would double-count current write), recording to instance on success.
    const boundary = () => Number(this.#query('SELECT ifnull(max(version), 0) AS v FROM _syncline_boundary')[0]?.v);
    let open = this.#chunkRows === undefined ? 0 : (this.#open ?? this.#countSince(boundary()));
    // Increments head from latest commit, continuing cumulative bytes and daily used counts.
    const latest = this.#latest();
    let head: Cookie = { version: Number(latest.version), nonce: Number(latest.nonce) };
    let total = Number(latest.bytes);
    const writtenVersions: number[] = [];
    let part: Entry[] = [];
    let bytes = 2;
    const insert = (keys: Keys, last: boolean) => {
      head = { version: head.version + 1, nonce: nonce() };
      // Advances client lmid only on the final segment; client ID is also recorded only on the final segment (cookies land on it, used by lmidsSince).
      if (last && client !== null)
        this.#query('INSERT INTO _syncline_client VALUES (?, ?) ON CONFLICT (client) DO UPDATE SET lmid = excluded.lmid', client, id);
      const today = used?.();
      const text = JSON.stringify(keys);
      // Accumulates cumulative bytes from previous commit; revise adds at most reserve bytes per entry in shared spaces.
      total += utf8Bytes(text);
      this.#query(
        'INSERT INTO _syncline_commit (version, nonce, keys, day, used, bytes, client) VALUES (?, ?, ?, ?, ?, ?, ?)',
        head.version,
        head.nonce,
        text,
        today?.day ?? latest.day ?? null,
        // Adds 1 for this commit log row: _syncline_commit has a rowid primary key with no secondary indexes, so one row counts as one write.
        today ? today.rows + 1 : (latest.used ?? null),
        total,
        last ? client : null,
      );
      if (this.#chunkRows === undefined) return;
      open += keys.length;
      if (open < this.#chunkRows) return;
      this.#query('INSERT INTO _syncline_boundary VALUES (?)', head.version);
      open = 0;
    };
    return {
      add: (entry) => {
        const size = utf8Bytes(JSON.stringify(entry)) + 1 + reserve;
        if (part.length > 0 && bytes + size > keysLimit) {
          insert(part, false);
          writtenVersions.push(head.version);
          part = [];
          bytes = 2;
        }
        part.push(entry);
        bytes += size;
      },
      finish: (revise = (keys) => keys) => {
        for (const at of writtenVersions) this.#revise(at, revise);
        insert(revise(part), true);
        if (this.#chunkRows !== undefined) this.#open = open;
        return head;
      },
    };
  }

  /** Returns the latest commit row (used by begin to continue history); head is never truncated and always present. */
  #latest() {
    const [row] = this.#query('SELECT version, nonce, bytes, day, used FROM _syncline_commit ORDER BY version DESC LIMIT 1');
    if (!row) throw new Error('Commit log is empty; initialize commit log before recording.');
    return row;
  }

  /** Reads back a written segment and passes it to revise; skips update if unchanged to minimize write billing. */
  #revise(version: number, revise: (keys: Keys) => Keys) {
    const text = String(this.#query('SELECT keys FROM _syncline_commit WHERE version = ?', version)[0]?.keys);
    const revised = JSON.stringify(revise(keysOf(text)));
    if (revised !== text) this.#query('UPDATE _syncline_commit SET keys = ? WHERE version = ?', revised, version);
  }

  /** Returns the most recently recorded daily writes (including the commit row itself), or undefined if no device writes exist. */
  used(): Used | undefined {
    const { day, used } = this.#latest();
    return day === null ? undefined : { day: Number(day), rows: Number(used) };
  }

  /**
   * Returns the latest chunk boundary (watermark for shared space full pulls); version 0 if no boundary exists, or the earliest commit after truncation.
   * Devices starting full pulls around the same time snap to the same watermark to share cached pull URLs.
   * @see https://github.com/electric-sql/electric/blob/3f9809fb0bd894cb74470d434749673492ad7acf/packages/sync-service/lib/electric/shape_cache/log_chunker.ex
   */
  watermark(): Cookie {
    return this.#cookie(
      'SELECT version, nonce FROM _syncline_commit WHERE version >= (SELECT ifnull(max(version), 0) FROM _syncline_boundary) ORDER BY version LIMIT 1',
    );
  }

  /** Queries a commit version from the log; head is always present since truncation never deletes it. */
  #cookie(sql: string) {
    const [row] = this.#query(sql);
    if (!row) throw new Error('Commit log is empty; initialize commit log before querying.');
    return { version: Number(row.version), nonce: Number(row.nonce) };
  }

  /** Returns a commit version on current history: from the commit log, or the log floor recorded during truncation; undefined if truncated or not yet created. */
  #row(version: number) {
    const [row] = this.#query(
      'SELECT nonce, bytes FROM _syncline_commit WHERE version = ? UNION ALL SELECT nonce, bytes FROM _syncline_low WHERE version = ?',
      version,
      version,
    );
    return row && { nonce: Number(row.nonce), bytes: Number(row.bytes) };
  }

  /**
   * Determines whether the cookie lies on the current history: the version exists (between floor and head) and the nonce matches.
   * Mismatched nonces (e.g. rolled back by point-in-time recovery) or cookies below the floor return false, requiring a full pull.
   */
  onHistory({ version, nonce }: Cookie) {
    return this.#row(version)?.nonce === nonce;
  }

  /** Returns the highest processed mutation ID (lmid) for client, or 0 if the client has not pushed writes. */
  lmid(client: string) {
    const [row] = this.#query('SELECT lmid FROM _syncline_client WHERE client = ?', client);
    return row ? Number(row.lmid) : 0;
  }

  /**
   * Returns a client -> lmid map for clients with commits after from (LmidsSince in TLA+ models).
   * Scans client IDs in commits after from and queries _syncline_client by primary key, bounded to at most ~3x the commit count in that range.
   * from must be on the current history.
   */
  lmidsSince(from: number) {
    return lmidsOf(
      this.#query(
        'SELECT client, lmid FROM _syncline_client WHERE client IN (SELECT _syncline_commit.client FROM _syncline_commit WHERE version > ? AND _syncline_commit.client IS NOT NULL)',
        from,
      ),
    );
  }

  /** Returns a client -> lmid map for the specified clients, passing clients as a JSON array to avoid parameter binding limits. */
  lmidsOf(clients: Iterable<string>) {
    return lmidsOf(
      this.#query(
        'SELECT client, lmid FROM _syncline_client WHERE client IN (SELECT value FROM json_each(?))',
        JSON.stringify([...clients]),
      ),
    );
  }

  /** Returns cumulative primary key bytes up to version; version must be on current history. */
  bytesAt(version: number) {
    const row = this.#row(version);
    if (!row) throw new Error(`Commit version ${version} not found in commit log; provide a version on current history.`);
    return row.bytes;
  }

  /** Estimates commit log byte size: cumulative key bytes above floor plus per-row overhead (rowOverhead). */
  bytes() {
    const [low] = this.#query('SELECT version, bytes FROM _syncline_low');
    const head = this.head().version;
    return this.bytesAt(head) - Number(low?.bytes ?? 0) + (head - Number(low?.version ?? 0)) * rowOverhead;
  }

  /** Determines whether commit log size exceeds its limit: at least floor bytes, or 1/4 of data size (databaseSize minus log size). */
  overLimit(databaseSize: number) {
    const bytes = this.bytes();
    return bytes > this.#cap(databaseSize, bytes);
  }

  #cap(databaseSize: number, bytes: number) {
    return Math.max(this.#floor, (databaseSize - bytes) / 4);
  }

  /**
   * Executes one log truncation step within a caller transaction: trims up to truncateRows commits and truncateBytes key bytes,
   * down to 3/4 of the cap (target, derived from databaseSize by default), preserving head.
   * Records the last deleted commit as the new floor in _syncline_low.
   * Returns true if more commits remain to be truncated.
   */
  truncate(databaseSize: number, target = this.#cap(databaseSize, this.bytes()) * 0.75) {
    const head = this.head().version;
    const [low] = this.#query('SELECT version, bytes FROM _syncline_low');
    // Initial floor is version 0 (empty database) before any truncation has run.
    const from = Number(low?.version ?? 0);
    const lowBytes = Number(low?.bytes ?? 0);
    // Remaining bytes after cutting at version v is approximately (totalBytes(head) + head * rowOverhead) - (totalBytes(v) + v * rowOverhead), requiring the second term to reach needed.
    const needed = this.bytesAt(head) + head * rowOverhead - target;
    const last = Math.min(from + truncateRows, head - 1);
    if (needed <= lowBytes + from * rowOverhead || last <= from) return false;
    // Both terms increase monotonically with version: finds the first version reaching or exceeding needed/budget and cuts up to it.
    const [stop] = this.#query(
      'SELECT version, nonce, bytes FROM _syncline_commit WHERE version > ? AND version <= ? AND (bytes + version * ? >= ? OR bytes > ?) ORDER BY version LIMIT 1',
      from,
      last,
      rowOverhead,
      needed,
      lowBytes + truncateBytes,
    );
    const over = stop !== undefined && Number(stop.bytes) > lowBytes + truncateBytes;
    const to = stop === undefined ? last : over ? Math.max(Number(stop.version) - 1, from + 1) : Number(stop.version);
    const cut =
      Number(stop?.version) === to ? stop : this.#query('SELECT version, nonce, bytes FROM _syncline_commit WHERE version = ?', to)[0];
    if (!cut) throw new Error(`Commit version ${to} not found in commit log; provide a version on current history.`);
    this.#query('DELETE FROM _syncline_commit WHERE version <= ?', cut.version);
    this.#query('DELETE FROM _syncline_boundary WHERE version <= ?', cut.version);
    this.#query('INSERT OR REPLACE INTO _syncline_low VALUES (1, ?, ?, ?)', cut.version, cut.nonce, cut.bytes);
    return Number(cut.version) < head - 1 && Number(cut.bytes) + Number(cut.version) * rowOverhead < needed;
  }

  /** Returns a batch of commits after from, ordered by version, bounded by batchRows commits and ~readBytes primary key bytes; read reports statement row count. */
  after(from: number) {
    const sizes = this.#query(
      'SELECT octet_length(keys) AS bytes FROM _syncline_commit WHERE version > ? ORDER BY version LIMIT ?',
      from,
      batchRows,
    );
    const commits = this.#query(
      'SELECT version, nonce, keys FROM _syncline_commit WHERE version > ? ORDER BY version LIMIT ?',
      from,
      within(sizes, readBytes),
    ).map((commit) => ({ cookie: { version: Number(commit.version), nonce: Number(commit.nonce) }, keys: keysOf(commit.keys) }));
    return { commits, read: commits.length * 2 };
  }

  /** Returns the total number of items in commits after from. */
  #countSince(from: number) {
    return Number(
      this.#query('SELECT ifnull(sum(json_array_length(keys)), 0) AS total FROM _syncline_commit WHERE version > ?', from)[0]?.total,
    );
  }
}
