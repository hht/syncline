import { eq } from 'drizzle-orm';
import { forward, forwardShared, SynclineBroadcast, SynclineSharedEntry, SynclineSharedSpace, SynclineSpace } from 'syncline/cloudflare';
import { verifyToken } from './auth.ts';
import { bucketsOf, cloud, imports, shared } from './definition.ts';
import { exportNotes } from './notes.ts';
import { document, note, revision, section } from './tables.ts';

// Example Worker: private spaces at /sync, and one shared space at /shared.

/** A private space per user, exporting its notes to D1. */
export class UserSpace extends SynclineSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    // Tests set EXPORT_DELAY to 0 so exports run on the next alarm; deployed Workers keep the default of 60 seconds.
    const exportDelay = env.EXPORT_DELAY === undefined ? {} : { exportDelay: Number(env.EXPORT_DELAY) };
    super(ctx, env, { note }, { exporters: { d1: exportNotes(env.EXPORTS, ctx.id) }, ...exportDelay });
  }

  /** Server write: adds a note to this space. */
  addNote(id: string, body: string) {
    this.mutate((tx) => tx.upsert(note, { id, body }));
  }
}

/** The shared space: the server writes here. */
export class SharedSpace extends SynclineSharedSpace<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { ...shared, cloud, broadcast: (bindings) => bindings.SHARED_BROADCAST });
  }

  /** Publishes or unpublishes a document, copying its status onto its revisions and sections in the same write. */
  setStatus(documentID: string, status: string) {
    return this.mutate((tx) => {
      tx.update(document, { id: documentID, status });
      this.#copyStatus(tx, documentID, status);
    });
  }

  /** Copies a document's status onto its revisions and sections, in the write that changes it. */
  #copyStatus(tx: Parameters<Parameters<SharedSpace['mutate']>[0]>[0], documentID: string, status: string) {
    const revisions = tx.select({ id: revision.id }).from(revision).where(eq(revision.document_id, documentID)).all();
    for (const { id } of revisions) {
      tx.update(cloud.revision, { id, status });
      for (const child of tx.select({ id: section.id }).from(section).where(eq(section.revision_id, id)).all())
        tx.update(cloud.section, { id: child.id, status });
    }
  }

  /** Adds a revision with its sections, copying the document's status onto each new row. */
  addRevision(documentID: string, id: string, number: number, sections: { id: string; body: string }[]) {
    return this.mutate((tx) => {
      const [parent] = tx.select({ status: document.status }).from(document).where(eq(document.id, documentID)).all();
      if (!parent) throw new Error(`No document ${documentID}`);
      tx.upsert(cloud.revision, { id, document_id: documentID, number, status: parent.status });
      for (const child of sections) tx.upsert(cloud.section, { ...child, revision_id: id, status: parent.status });
    });
  }

  /**
   * Imports one batch of documents sorted by id, recording the last id in the same write. Upserts make a retried batch harmless, so
   * after an error the caller asks `imported` where to continue. A document already present whose status changes copies it onto its
   * revisions and sections, as `setStatus` does.
   */
  importDocuments(job: string, rows: (typeof document.$inferInsert)[]) {
    return this.mutate((tx) => {
      for (const row of rows) {
        const [before] = tx.select({ status: document.status }).from(document).where(eq(document.id, row.id)).all();
        tx.upsert(document, row);
        if (before && before.status !== row.status) this.#copyStatus(tx, row.id, row.status);
      }
      const last = rows.at(-1);
      if (last) tx.upsert(imports, { job, after: last.id });
    });
  }

  /** Returns the id of the last document a job imported, or undefined before its first batch. */
  imported(job: string) {
    const [row] = this.ctx.storage.sql.exec<{ after: string }>('SELECT after FROM import_progress WHERE job = ?', job).toArray();
    return row?.after;
  }
}

/** Broadcast objects holding devices' live connections to the shared space. */
export class SharedBroadcast extends SynclineBroadcast<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, env.SHARED_SPACE);
  }
}

/** The entrypoint answering shared space downloads, behind Workers Cache. */
export class SharedEntry extends SynclineSharedEntry<Env> {
  protected shared() {
    return this.env.SHARED_SPACE;
  }
}

/** Routes private space sync to `/sync` and the shared space to `/shared`. */
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/shared') {
      const route = { entry: ctx.exports.SharedEntry, broadcast: env.SHARED_BROADCAST, space: 'shared', definition: shared };
      return forwardShared(request, route, async (token) => {
        const user = await verifyToken(token, env.TOKEN_SECRET);
        return user && { buckets: bucketsOf(user), expiresAt: user.expiresAt };
      });
    }
    if (pathname === '/sync')
      return forward(request, env.USER_SPACE, async (token) => {
        const user = await verifyToken(token, env.TOKEN_SECRET);
        return user && { space: user.id, expiresAt: user.expiresAt };
      });
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
