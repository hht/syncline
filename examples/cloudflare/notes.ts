import type { Exporter } from 'syncline/cloudflare';

// An exporter copying every private space's notes into one D1 database.

type Op = Parameters<Exporter['write']>[0]['patch'][number];

// Runs a statement only while the space's stored position (?1, ?2) is still the chunk's from.
const current = '(SELECT position FROM export_position WHERE space = ?1) IS ?2';

/** The statement that writes op for space, or undefined for ops this destination ignores (other tables, dropped columns). */
function statementOf(db: D1Database, at: unknown[], op: Op) {
  if (op.op === 'clear' || (op.op === 'drop' && op.table === 'note' && !('columns' in op)))
    return db.prepare(`DELETE FROM exported_note WHERE space = ?1 AND ${current}`).bind(...at);
  if (op.op === 'put' && op.table === 'note')
    return db
      .prepare(
        `INSERT INTO exported_note (space, id, body) SELECT ?1, ?3, ?4 WHERE ${current} ON CONFLICT DO UPDATE SET body = excluded.body`,
      )
      .bind(...at, op.row.id, op.row.body);
  if (op.op === 'del' && op.table === 'note')
    return db.prepare(`DELETE FROM exported_note WHERE space = ?1 AND id = ?3 AND ${current}`).bind(...at, op.key.id);
  return undefined;
}

/**
 * Exports one space's notes to D1, under the space's name. Every statement of a chunk runs only while the stored position still equals
 * `from`, and the same batch saves `next`, so a retried or overlapping chunk changes nothing. The name is read when an export runs, which
 * throws for an object without one (Cloudflare gives the name only to objects reached by a name of at most 1,024 bytes), so the export
 * retries instead of writing under another key.
 * @see https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
 * @see https://developers.cloudflare.com/durable-objects/api/id/#name
 */
export function exportNotes(db: D1Database, id: DurableObjectId): Exporter {
  const space = () => {
    if (id.name === undefined) throw new Error('This space has no name to export under: reach it with getByName');
    return id.name;
  };
  return {
    position: async () =>
      (await db.prepare('SELECT position FROM export_position WHERE space = ?').bind(space()).first<string>('position')) ?? undefined,
    write: async ({ from, next, patch }) => {
      const at = [space(), from ?? null];
      const statements = patch.flatMap((op) => statementOf(db, at, op) ?? []);
      const save = `INSERT INTO export_position (space, position) SELECT ?1, ?3 WHERE ${current} ON CONFLICT DO UPDATE SET position = excluded.position`;
      await db.batch([...statements, db.prepare(save).bind(...at, next)]);
    },
  };
}
