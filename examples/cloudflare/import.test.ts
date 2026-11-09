import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { pull, tokenFor } from './client.ts';
import { importAll } from './import.ts';

// Bulk imports into a shared space: batches under the row limit, resumed after a failure.

const space = () => env.SHARED_SPACE.getByName('shared');
const admin = { id: 'admin', admin: true, teams: [] as string[], level: 1 };
const rows = (count: number, level = 1) =>
  Array.from({ length: count }, (_, index) => ({
    id: `doc-${String(index).padStart(5, '0')}`,
    team_id: 'team-a',
    level,
    status: 'published',
    title: `Document ${index}`,
  }));

test('an import interrupted by an error continues from the last recorded batch', async () => {
  const source = rows(2500);
  // An invalid value in the third batch fails that write, as a crash or timeout would stop the import.
  const broken = source.map((row, index) => (index === 2100 ? { ...row, level: Number.NaN } : row));
  await expect(importAll(space(), 'initial', broken)).rejects.toThrow();
  expect(await space().imported('initial')).toBe('doc-01999');
  await importAll(space(), 'initial', source);
  expect(await space().imported('initial')).toBe('doc-02499');
  expect((await pull(await tokenFor(admin))).rows.document).toHaveLength(2500);
});

test('one shared space write takes at most 10,000 rows', async () => {
  const outcome = await space()
    .importDocuments('too-big', rows(10_001))
    .then(
      () => 'committed',
      (error: unknown) => String(error),
    );
  expect(outcome).toContain('modified more than 10000 rows');
  expect(await space().imported('too-big')).toBeUndefined();
});
