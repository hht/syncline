import { defineBackgroundSync } from 'syncline/expo/background';
import { note } from '../cloudflare/tables.ts';

// Background sync of the example's private space on iOS and Android.

/** The signed-in user as your sign-in keeps it, or undefined when signed out. */
type Session = () => Promise<{ userID: string; token: () => Promise<string> } | undefined>;

/** Defines what a background run syncs. Call it at the top level of the app's entry module. */
export function defineSync(session: Session) {
  defineBackgroundSync(async () => {
    const user = await session();
    return user && { name: 'app', schema: { note }, url: 'https://api.example.com/sync', ...user };
  });
}
