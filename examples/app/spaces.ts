import { openSyncline } from 'syncline/expo';
import { document, note, revision, section } from '../cloudflare/tables.ts';

// App side of the example: the private space and the shared space, reconnected whenever the signed-in user's token changes.

/** Opens both spaces for the signed-in user; `onTokenChanged` stands for your auth listener, such as Firebase's onIdTokenChanged. */
export function openSpaces(userID: string, token: () => Promise<string>, onTokenChanged: (listener: () => void) => void) {
  const syncline = openSyncline({ name: 'app', userID, schema: { note }, url: 'https://api.example.com/sync', token });
  const shared = syncline.openShared('shared', {
    schema: { document, revision, section },
    url: 'https://api.example.com/shared',
    userID,
  });
  onTokenChanged(() => {
    syncline.reconnect();
    shared.reconnect();
  });
  return { syncline, shared };
}
