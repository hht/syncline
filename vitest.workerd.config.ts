import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Syncline 依赖的平台假设在真的 Workers 运行时（workerd）里测，绑定照 wrangler.jsonc
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './src/cloudflare/wrangler.jsonc' } })],
  test: { name: 'syncline-cloudflare', include: ['src/**/*.workerd.test.ts'] },
});
