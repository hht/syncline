import { readOnlyOf } from '../tables/declaration.ts';
import { deviceDefinitions, tableName } from '../tables/table-definitions.ts';
import { checkDeclared } from '../tables/validation.ts';
import type { OpenOptions, Schema } from './syncline.ts';

/**
 * What the core's open call receives from the options of openSyncline: tables encoded as metadata, the owner, and checksum settings;
 * refuses options that would reach the core wrong.
 * What this module must not know: how the call reaches the core or what the core does with it.
 */

/** Serializes opening options for the core: encodes tables as metadata; leaves daily checksum rows to core defaults unless specified. */
export function opening<S extends Schema>(options: OpenOptions<S>) {
  const { schema, localOnly = {}, retired = [], readOnly = [], validation, userID, discardPending, checksumRowsPerDay } = options;
  // Without an owner the core records and clears nothing, so the next user to sign in would read this one's rows
  if (typeof userID !== 'string' || userID === '') throw new TypeError(`userID must be a non-empty string, got ${JSON.stringify(userID)}`);
  const tables = Object.values(schema);
  const localTables = Object.values(localOnly);
  checkDeclared(tables);
  return {
    config: {
      synced: deviceDefinitions(tables),
      localOnly: deviceDefinitions(localTables, { localOnly: true }),
      readOnly: [...readOnlyOf(tables, readOnly)],
      retired,
      schemas: [...tables, ...localTables].filter((table) => validation?.has(table)).map(tableName),
    },
    owner: userID,
    ...(discardPending && { discardPending }),
    checksum: checksumRowsPerDay === undefined ? {} : { rowsPerDay: checksumRowsPerDay },
  };
}
