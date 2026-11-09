import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Creates the export tables before each test file, as wrangler d1 migrations apply does before wrangler dev.
await applyD1Migrations(env.EXPORTS, env.MIGRATIONS);
