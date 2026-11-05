import { eq } from 'drizzle-orm';
import { test } from 'vitest';
import { holds, synced, upload } from './test-roundtrip.ts';
import { write } from './test-schema.ts';
import { reading } from './test-values.ts';

// Primary key values survive sync: rows they address update and delete identically on every device and the cloud.

// Found by random primary key tests: a real key past 2^53 that holds an integer (404056924716696060 is the double 404056924716696064).
test('a real key past 2^53 holding an integer addresses its row: an update by key changes the row on every device and the cloud', async () => {
  const { cloud, space, devices } = await synced(2);
  const [phone, tablet] = devices;
  if (!phone || !tablet) throw new Error('two devices');
  const at = 404056924716696060;
  await write(phone.device, (tx) => tx.insert(reading).values({ at, note: 'phone' }));
  await upload(space, phone.device, [phone.device, tablet.device]);
  await write(tablet.device, (tx) => tx.update(reading).set({ note: 'tablet' }).where(eq(reading.at, at)));
  await upload(space, tablet.device, [phone.device, tablet.device]);
  holds([phone.storage, tablet.storage, cloud], reading, [{ at, note: 'tablet' }]);
});
