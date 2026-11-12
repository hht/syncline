import { eq } from 'drizzle-orm';
import { openSyncline, type Syncline } from 'syncline/expo';
import { note } from '../cloudflare/tables.ts';

// App side of the example's private space: opening the local database for the signed-in user, writing, syncing, and signing out.

/** Opens the signed-in user's database and resolves once it has opened. */
export async function openDatabase(userID: string, token: () => Promise<string>) {
  const syncline = openSyncline({
    name: 'app',
    userID,
    schema: { note },
    url: 'https://api.example.com/sync',
    token,
  });
  await syncline.waitForReady();
  return syncline;
}

/** Adds a note unless one with this ID exists, reading and writing through the same transaction. */
export async function addNote(syncline: Syncline, id: string, body: string) {
  await syncline.write(async (tx) => {
    const [existing] = await tx.select().from(note).where(eq(note.id, id));
    if (!existing) await tx.insert(note).values({ id, body });
  });
}

/** Syncs now, giving up after `timeout` milliseconds. */
export async function syncNow(syncline: Syncline, timeout: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Sync timed out')), timeout);
  await syncline.sync({ signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Signs the user out: uploads the writes still pending, then closes the database. */
export async function signOut(syncline: Syncline) {
  if (syncline.status().pending > 0) await syncline.sync();
  await syncline.close();
}
