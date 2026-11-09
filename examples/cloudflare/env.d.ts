// Bindings only tests set (vitest.config.ts): an export delay of 0 for the Worker, and the D1 migrations setup.ts applies.
interface Env {
  EXPORT_DELAY?: string;
}

declare namespace Cloudflare {
  interface Env {
    MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
