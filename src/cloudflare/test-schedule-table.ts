import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

// Schedule tests without a Durable Object: the schedule table on in-memory SQLite.

const sqlite3 = await sqlite3InitModule();

/** In-memory schedule table with the schema the cloud creates; exec returns rows the way Durable Object SQL storage does, as the schedule reads them. */
export function scheduleTable() {
  const db = new sqlite3.oo1.DB(':memory:');
  db.exec(
    'CREATE TABLE _syncline_schedule (name TEXT PRIMARY KEY, at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, resets INTEGER NOT NULL DEFAULT 0)',
  );
  return {
    exec: (sql: string, ...bind: (string | number)[]) => {
      const rows = db.exec({ sql, bind, returnValue: 'resultRows', rowMode: 'object' });
      return { toArray: () => rows };
    },
  };
}

/** Lets the alarm's promises settle (the schedule awaits storage calls between steps). */
export const flush = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
};
