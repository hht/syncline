import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { keyColumns } from './keys.ts';
import { defaultOf, type Schema, tableName } from './table-definitions.ts';
import { storageTypeOf } from './validation.ts';

/**
 * Cloud tables: cloud-only tables, and synced tables declared again to add cloud-only columns.
 * A cloud table named like a synced table replaces it when tables are created, while pushes, pulls, and validation keep following the
 * schema: the cloud table must store the synced table as the schema declares it.
 * What this module must not know: how tables are created or written.
 */

const byName = (schema: Schema) => Object.values(schema).map((table) => [tableName(table), table] as const);

const defaultText = (value: string | undefined) => (value === undefined ? 'no default' : `default ${value}`);

// Throws unless cloud table `table` stores synced table `declared` as the schema declares it. A column left out fails every pull
// scanning the table; that, another storage type, or another primary key holds every pushed write that meets it; a non-null column
// added without the schema's default leaves the stored rows null; and a primary key in another column order makes every pull chunk
// scan and sort the whole table.
function checkStoredAlike(name: string, table: SQLiteTable, declared: SQLiteTable) {
  const cloudColumns = new Map(getTableConfig(table).columns.map((column) => [column.name, column]));
  for (const column of getTableConfig(declared).columns) {
    const cloud = cloudColumns.get(column.name);
    if (!cloud)
      throw new Error(
        `Cloud table ${name} omits column ${column.name}, which the schema declares; a cloud table must declare every column of the synced table it replaces`,
      );
    const type = storageTypeOf(name, cloud);
    const declaredType = storageTypeOf(name, column);
    if (type !== declaredType)
      throw new Error(
        `Cloud table column ${name}.${column.name} is ${type}, but the schema declares ${declaredType}; a cloud table must keep the storage type of every synced column`,
      );
    const value = defaultOf(cloud);
    const declaredValue = defaultOf(column);
    if (value !== declaredValue)
      throw new Error(
        `Cloud table column ${name}.${column.name} has ${defaultText(value)}, but the schema declares ${defaultText(declaredValue)}; a cloud table must keep the default of every synced column`,
      );
  }
  const key = keyColumns(table).join(', ');
  const declaredKey = keyColumns(declared).join(', ');
  if (key !== declaredKey)
    throw new Error(
      `Cloud table ${name} has primary key (${key}), but the schema declares (${declaredKey}); a cloud table must keep the primary key of the synced table it replaces, and key columns take the order the table declares its columns in`,
    );
}

/**
 * Combines synced tables with cloud tables: a cloud table replaces the synced table of the same name, and the others are cloud-only.
 * Throws unless each replacing cloud table declares every column of the synced table with its storage type and default, and its
 * primary key with the key columns in the same order.
 */
export function cloudTables(schema: Schema, cloud: Schema = {}) {
  const synced = new Map(byName(schema));
  const replacing = byName(cloud);
  for (const [name, table] of replacing) {
    const declared = synced.get(name);
    if (declared) checkStoredAlike(name, table, declared);
  }
  return [...new Map([...synced, ...replacing]).values()];
}
