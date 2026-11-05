import { drizzle } from 'drizzle-orm/durable-sqlite';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import { Space } from '../cloud/space.ts';
import { parseMutations } from '../common/parse.ts';
import { defineTables } from '../tables/table-definitions.ts';
import type { Device } from './test-device.ts';
import { install } from './test-schema.ts';
import { cloudStorage } from './test-storage.ts';
import { sorted, valueTables } from './test-values.ts';

// Round-trip harness for value tests: a cloud with the value tables and installed devices, uploads that go through the push
// parser, and readers comparing rows across devices and the cloud.

/** Cloud space over the value tables (created as the Durable Object creates them) with `count` installed devices. */
export async function synced(count: number) {
  const cloud = cloudStorage();
  defineTables(cloud, valueTables);
  const space = new Space(cloud, valueTables);
  const devices: Awaited<ReturnType<typeof install>>[] = [];
  for (let index = 0; index < count; index += 1) devices.push(await install(space, valueTables, []));
  return { cloud, space, devices };
}

/** Pushes pending writes as the cloud receives them (JSON text through the push parser) and delivers the poke to online devices. */
export async function upload(space: Space, from: Device, online: Device[]) {
  const pending = from.private.pending();
  if (pending.length === 0) return;
  const poke = space.push(parseMutations(JSON.stringify(pending)));
  if (poke) for (const device of online) await device.private.receive(poke);
}

type Readable = Parameters<typeof drizzle>[0];

/** Rows of a table as Drizzle reads them from device or cloud storage, sorted. */
export const rows = (storage: unknown, table: SQLiteTable) =>
  sorted(
    drizzle(storage as Readable)
      .select()
      .from(table)
      .all(),
  );

/** Asserts every storage holds exactly the expected rows of a table. */
export function holds(storages: unknown[], table: SQLiteTable, expected: unknown[]) {
  for (const storage of storages) expect(rows(storage, table)).toEqual(expected);
}
