import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Bucket, SharedDefinition } from 'syncline/cloudflare';
import { document, revision, section } from './tables.ts';

// Bucket rules and cloud tables of the example shared space, imported by both the entry Worker and the shared space Durable Object.

/** Cloud-only table: how far each import job has got. */
export const imports = sqliteTable('import_progress', { job: text().primaryKey(), after: text().notNull() });

/** Cloud tables: children keep a copy of their document's status, which devices never receive, and imports record their progress. */
export const cloud = {
  import_progress: imports,
  revision: sqliteTable('revision', {
    id: text().primaryKey(),
    document_id: text().notNull(),
    number: integer().notNull(),
    status: text().notNull(),
  }),
  section: sqliteTable('section', {
    id: text().primaryKey(),
    revision_id: text().notNull(),
    body: text().notNull(),
    status: text().notNull(),
  }),
};

/** The shared space's tables and bucket rules. */
export const shared = {
  schema: { document, revision, section },
  rules: {
    public: {
      document: { where: "status = 'published'" },
      revision: { where: "status = 'published'" },
      section: { where: "status = 'published'" },
    },
    admin: { document: {}, revision: {}, section: {} },
    team: { document: { by: ['team_id'] } },
    level: { document: { by: ['level'] } },
  },
} satisfies SharedDefinition;

/** A signed-in user as your token check returns it. */
export type User = { id: string; admin: boolean; teams: string[]; level: number; expiresAt: number };

/** Buckets a user may read: text columns take strings, integer columns take numbers. */
export function bucketsOf(user: User): Bucket[] {
  return [
    ['public'],
    ...(user.admin ? [['admin'] as Bucket] : []),
    ...user.teams.map((team): Bucket => ['team', team]),
    ['level', user.level],
  ];
}
