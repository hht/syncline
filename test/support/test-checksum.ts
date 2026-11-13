import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { Space as CoreSpace } from '../../src/cloud/space.ts';
import type { PullRequest } from '../../src/common/pull-url.ts';
import type { CloudStorage } from '../../src/common/storage.ts';
import { spaceChecksum } from '../../src/features/checksum/cloud/checksums.ts';
import { defineTables } from '../../src/tables/table-definitions.ts';
import { Device as CoreDevice } from './test-device.ts';
import type { rustStorage } from './test-rust.ts';
import { unchunked } from './test-schema.ts';
import { cloudStorage } from './test-storage.ts';
import { valueTables } from './test-values.ts';

// Device and Space wired with online checksum verification (configured at runtime in production): tests requiring checksum verification import here.

/** checksumRowsPerDay: daily row budget for checksum verification. */
type DeviceOptions = NonNullable<ConstructorParameters<typeof CoreDevice>[2]> & { checksumRowsPerDay?: number };

export class Device extends CoreDevice {
  constructor(storage: ReturnType<typeof rustStorage>, tables: SQLiteTable[], { checksumRowsPerDay, ...options }: DeviceOptions = {}) {
    super(storage, tables, { checksum: { rowsPerDay: checksumRowsPerDay }, ...options });
  }
}

export class Space extends CoreSpace {
  constructor(storage: CloudStorage, tables: SQLiteTable[], options: ConstructorParameters<typeof CoreSpace>[2] = {}) {
    super(storage, tables, { checksum: spaceChecksum, ...options });
  }
}

/** Cloud over the value tables (created as the Durable Object creates them) computing checksums on pulls. */
export function checksumCloud() {
  const cloud = cloudStorage();
  defineTables(cloud, valueTables);
  return { cloud, space: new Space(cloud, valueTables) };
}

/** Pulls until caught up, asking the cloud for segments of `rows` rows whenever the device asks for a checksum. */
export async function download(space: Space, device: Device, rows: number) {
  const sized = (request: PullRequest) => (request.checksum === undefined ? request : { ...request, checksumRows: rows });
  for (let step = 0; step === 0 || device.private.behind(); step += 1) {
    if (step > 20) throw new Error('Download exceeded 20 steps');
    // Requests travel as a JSON body, as private space HTTP pulls do.
    await device.private.receive(space.pull(JSON.parse(JSON.stringify(sized(device.private.pullRequest()))), unchunked));
  }
}

/** Verifies segment after segment (refetching after a mismatch) until the round completes; returns each segment's outcome. */
export async function round(space: Space, device: Device, rows: number) {
  const outcomes: (boolean | undefined)[] = [];
  for (let segment = 0; segment < 100; segment += 1) {
    outcomes.push(await device.private.verify());
    if (!device.private.behind()) return outcomes;
    await download(space, device, rows);
  }
  throw new Error('Verification round did not complete within 100 segments');
}
