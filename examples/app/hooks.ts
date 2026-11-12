import { useQuery, useSyncline, useSyncStatus } from 'syncline/react';
import { note } from '../cloudflare/tables.ts';

// React side of the example: hooks for components below a SynclineProvider.

/** Every note, read again whenever the note table changes. */
export function useNotes() {
  return useQuery((db) => db.select().from(note));
}

/** Returns a function that adds a note to the open database. */
export function useAddNote() {
  const { write } = useSyncline();
  return (id: string, body: string) => write(async (tx) => tx.insert(note).values({ id, body }));
}

/** Whether writes are still waiting to upload. */
export function useUnsynced() {
  const { pending } = useSyncStatus();
  return pending > 0;
}
