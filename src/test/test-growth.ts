import { rowOverhead } from '../cloud/commits.ts';

// State that must stay bounded however long a simulation runs, checked once it settled and upkeep truncated the commit log: internal tables
// on the cloud and devices, and network state. Synced tables hold app data and are not checked.
// What it must not know: how the simulations reach that state.

type Database = { sql: { exec(sql: string): { toArray(): Record<string, unknown>[] } } };

/**
 * Internal tables holding one row per space, synced table or column, retired name, rule, bucket, or schema version, or rows of a table the
 * device does not declare yet (the 3 memo keys): bounded by the schema, which in the simulations declares at most 3 tables, 6 columns,
 * and 4 buckets.
 */
const metaRows = 8;

/**
 * Internal tables that grow with what the app did, excluded: an lmid row per write-enabled launch, never deleted
 * (an architecture decision), and held writes, kept until resubmitted. The commit log and chunk boundaries are bounded by the log cap instead.
 */
const excluded = new Set(['_syncline_client', '_syncline_held', '_syncline_commit', '_syncline_boundary']);

/**
 * Timers a device has scheduled at once: one per kind of the device core's Timer (Reconnect, Beat, Renewal, PullWait,
 * TokenTimeout, Resume for Verify and for Shrink, Stuck) and the HTTP stall watch ({@link stallWatch}).
 */
const deviceTimers = 9;

/** Row counts of Syncline's internal tables in a database. */
function internalRows(storage: Database) {
  const tables = storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_syncline\\_%' ESCAPE '\\'")
    .toArray()
    .map(({ name }) => String(name));
  return Object.fromEntries(tables.map((name) => [name, Number(storage.sql.exec(`SELECT count(*) AS n FROM "${name}"`).toArray()[0]?.n)]));
}

/**
 * Checks state that must stay bounded however long a simulation runs, once it settled and upkeep truncated the commit log: the log fits its
 * cap (commitFloor, as the simulations report a database size of 0) by the estimate truncation uses (key bytes plus {@link rowOverhead} per commit)
 * unless only the head is left; chunk boundaries number at most the commits; other internal tables stay within metaRows on the
 * cloud and every device; the cloud holds at most two sockets per device (one closing), and the devices at most deviceTimers timers
 * per device in total (the network does not tell timers apart by device).
 */
export function checkSettled({
  cloud,
  devices,
  network,
  commitFloor,
}: {
  cloud: Database;
  devices: Database[];
  network: { timers: number; accepted: number };
  commitFloor: number;
}) {
  const violations: string[] = [];
  const within = (what: string, size: number, bound: number) => {
    if (size > bound) violations.push(`${what} is ${size}, over its bound of ${bound}`);
  };
  const [history] = cloud.sql.exec('SELECT count(*) AS commits, sum(octet_length(keys)) AS bytes FROM _syncline_commit').toArray();
  const commits = Number(history?.commits);
  if (commits > 1) within('cloud commit log bytes', Number(history?.bytes) + commits * rowOverhead, commitFloor);
  for (const [index, storage] of [cloud, ...devices].entries())
    for (const [table, rows] of Object.entries(internalRows(storage))) {
      const where = index === 0 ? 'cloud' : `device ${index - 1}`;
      within(
        `${where} ${table} rows`,
        rows,
        table === '_syncline_boundary' ? commits : excluded.has(table) ? Number.POSITIVE_INFINITY : metaRows,
      );
    }
  within('accepted cloud sockets', network.accepted, 2 * devices.length);
  within('device timers', network.timers, deviceTimers * devices.length);
  if (violations.length > 0) throw new Error(`state grew past its bounds: ${violations.join('; ')}`);
}
