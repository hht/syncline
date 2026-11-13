import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Space } from '../../src/cloud/space.ts';
import type { Storage } from '../../src/sqlite/storage.ts';
import { install, upload, write } from '../support/test-schema.ts';
import { cloudStorage } from '../support/test-storage.ts';

// Shared test helpers for local write and foreign key tests: workbook, excerpt, set tables with cascading references.

export const workbook = sqliteTable('workbook', {
  id: text().primaryKey(),
  note: text(),
  runs: integer(),
  weight: real(),
  done: integer({ mode: 'boolean' }),
  extra: text({ mode: 'json' }).$type<Record<string, unknown>>(),
});
export const excerpt = sqliteTable('excerpt', { id: text().primaryKey(), workbook_id: text().references(() => workbook.id), name: text() });
export const set = sqliteTable('set', { id: text().primaryKey(), excerpt_id: text().references(() => excerpt.id) });
export const tables = [workbook, excerpt, set];
export const statements = [
  'CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, runs INTEGER, weight REAL, done INTEGER, extra TEXT)',
  'CREATE TABLE excerpt (id TEXT PRIMARY KEY, workbook_id TEXT, name TEXT)',
  'CREATE TABLE "set" (id TEXT PRIMARY KEY, excerpt_id TEXT)',
];

export const w1 = { id: 'w1', note: 'stamp', runs: 5, weight: 102.5, done: true, extra: { rev: 8 } };

/** Cloud space and two devices pre-populated with workbook w1 and excerpt e1. */
export async function withWorkbook() {
  const cloud = cloudStorage(...statements);
  const space = new Space(cloud, tables);
  const phone = await install(space, tables, statements);
  const tablet = await install(space, tables, statements);
  const devices = [phone.device, tablet.device];
  await write(phone.device, async (tx) => {
    await tx.insert(workbook).values(w1);
    await tx.insert(excerpt).values({ id: 'e1', workbook_id: 'w1', name: 'stamp' });
  });
  await upload(space, phone.device, devices);
  return { cloud, space, phone, tablet, devices };
}

export const read = (storage: Storage) => ({
  workbooks: drizzle(storage).select().from(workbook).orderBy(workbook.id).all(),
  excerpts: drizzle(storage).select().from(excerpt).orderBy(excerpt.id).all(),
  sets: drizzle(storage).select().from(set).orderBy(set.id).all(),
});
