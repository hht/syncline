import { join } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs the example's tests in workerd with the bindings of wrangler.jsonc, after creating the export tables in D1, exporting right after writes.
// @see https://developers.cloudflare.com/workers/testing/vitest-integration/
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: join(import.meta.dirname, 'wrangler.jsonc') },
      miniflare: { bindings: { MIGRATIONS: await readD1Migrations(join(import.meta.dirname, 'migrations')), EXPORT_DELAY: '0' } },
    }),
  ],
  test: {
    name: 'example-cloudflare',
    root: import.meta.dirname,
    include: ['*.test.ts'],
    setupFiles: ['setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
}));
