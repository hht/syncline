import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { Space as CoreSpace } from '../cloud/space.ts';
import type { CloudStorage } from '../common/storage.ts';
import { spaceChecksum } from '../features/checksum/cloud/checksums.ts';
import { Device as CoreDevice } from './test-device.ts';
import type { rustStorage } from './test-rust.ts';

// 接上在线校验和的设备与空间（产品里由各入口接上）：要对校验和的测试从这里取 Device、Space

/** checksumRowsPerDay：校验和每天至多要多少行 */
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
