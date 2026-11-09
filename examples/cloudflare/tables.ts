import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Tables as devices receive them, imported by both the app and the cloud: the private space's notes, and the shared space's tables.

/** A private space's note. */
export const note = sqliteTable('note', { id: text().primaryKey(), body: text().notNull() });

/** A shared document; `status` decides who sees it. */
export const document = sqliteTable('document', {
  id: text().primaryKey(),
  team_id: text().notNull(),
  level: integer().notNull(),
  status: text().notNull(),
  title: text().notNull(),
});

/** A revision of a document, as devices receive it: the cloud adds a copy of the document's status. */
export const revision = sqliteTable('revision', {
  id: text().primaryKey(),
  document_id: text().notNull(),
  number: integer().notNull(),
});

/** A section of a revision, as devices receive it: the cloud adds a copy of the document's status. */
export const section = sqliteTable('section', {
  id: text().primaryKey(),
  revision_id: text().notNull(),
  body: text().notNull(),
});
