import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { holds, rows, synced, upload } from './test-roundtrip.ts';
import { write } from './test-schema.ts';
import { item, readBack, reading } from './test-values.ts';

// Column values survive every sync path unchanged (device write → push → poke → other devices and new installs; server write → poke
// and pull), or the write that carries them throws when it is made, as the documented limits promise.

// Regressions found by value property tests: the device core parsed JSON numbers with serde_json's default float parser, so a double
// with 16 or 17 significant digits came back one ulp off wherever it entered the core (a local write's parameters, pokes, and pulls).

test('a real computed by the app (0.2 + 0.01) reads back unchanged on the device that wrote it', async () => {
  const { devices } = await synced(1);
  const [phone] = devices;
  if (!phone) throw new Error('one device');
  const ratio = 0.2 + 0.01;
  expect(ratio).toBe(0.21000000000000002);
  await write(phone.device, (tx) => tx.insert(item).values({ id: 'w1', ratio }));
  holds([phone.storage], item, [readBack({ id: 'w1', ratio })]);
});

test('a real from a server write (11 * 1.1) reaches the device as the cloud stores it', async () => {
  const { cloud, space, devices } = await synced(1);
  const [phone] = devices;
  if (!phone) throw new Error('one device');
  const ratio = 11 * 1.1;
  expect(ratio).toBe(12.100000000000001);
  await phone.device.private.receive(space.mutate((tx) => tx.insert(item, { id: 'w1', ratio })));
  holds([cloud, phone.storage], item, [readBack({ id: 'w1', ratio })]);
});

test('a device deleting a row keyed by a real from a server write deletes it on the cloud and keeps it deleted', async () => {
  const { cloud, space, devices } = await synced(1);
  const [phone] = devices;
  if (!phone) throw new Error('one device');
  await phone.device.private.receive(space.mutate((tx) => tx.insert(reading, { at: 0.2 + 0.01, note: 'n' })));
  const [seen] = rows(phone.storage, reading) as (typeof reading.$inferSelect)[];
  if (!seen) throw new Error('device should hold the row');
  await write(phone.device, (tx) => tx.delete(reading).where(eq(reading.at, seen.at)));
  await upload(space, phone.device, [phone.device]);
  holds([cloud, phone.storage], reading, []);
});

test('a real written on one device converges: the writer, the cloud, and another device hold the same value', async () => {
  const { cloud, space, devices } = await synced(2);
  const [phone, tablet] = devices;
  if (!phone || !tablet) throw new Error('two devices');
  await write(phone.device, (tx) => tx.insert(item).values({ id: 'w1', ratio: 4.4307680890698356e226 }));
  await upload(space, phone.device, [phone.device, tablet.device]);
  holds([phone.storage, tablet.storage, cloud], item, [readBack({ id: 'w1', ratio: 4.4307680890698356e226 })]);
});
