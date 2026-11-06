import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests platform assumptions in the real Workers runtime (workerd), with bindings configured by wrangler.jsonc.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './src/cloudflare/wrangler.jsonc' } })],
  // Same hang-only timeout as the fast project (vitest.config.ts).
  test: { name: 'syncline-cloudflare', include: ['src/**/*.workerd.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
