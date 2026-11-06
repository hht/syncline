import { requireNativeModule } from 'expo';
import { Client, type Received } from './client.ts';
import { OpenDatabases } from './open-databases.ts';
import { type OpenOptions, type Schema, type Syncline, syncline } from './syncline.ts';

export * from './public.ts';

/**
 * Opens Syncline on iOS and Android with the local database and sync running inside the native module.
 *
 * Rust core and network worker threads (`rust/native`) run native sync operations; the JS thread only issues calls and receives responses
 * and events. Each database receives a handle: calls are serialized as JSON over `send`, and incoming responses are dispatched by handle
 * to their respective Client instances via `message` events. Database files reside in the app data directory.
 * What this module must not know: Table business logic or internal sync mechanics.
 * @see https://docs.expo.dev/modules/module-api/
 */

type SynclineModule = {
  /** Starts the core thread for a database and returns its handle (the database opens upon receiving the open call). */
  start(name: string): number;
  send(handle: number, call: string): void;
  /** Deletes the database file (the database must be closed first). */
  remove(name: string): Promise<void>;
  addListener(event: 'message', listener: (event: { handle: number; data: string }) => void): { remove(): void };
};

/** Open databases keyed by handle. */
const clients = new Map<number, Client>();

/** Loads the native module lazily on first open so modules importing this file without opening a database do not fail. */
let loaded: SynclineModule | undefined;
function native() {
  if (!loaded) {
    loaded = requireNativeModule<SynclineModule>('Syncline');
    loaded.addListener('message', ({ handle, data }) => clients.get(handle)?.receive(JSON.parse(data) as Received[]));
  }
  return loaded;
}

/** Open databases in this process. */
const opened = new OpenDatabases<Syncline>();

/**
 * Opens or creates a local database and starts synchronizing its private space.
 *
 * Closes an instance a background syncOnce task opened first, so these options take effect; throws if already open in the foreground
 * under the same name.
 */
export function openSyncline<S extends Schema>(options: OpenOptions<S>) {
  return opened.open(options.name, () => open(options));
}

function open<S extends Schema>(options: OpenOptions<S>) {
  const { name, token } = options;
  const module = native();
  // Lazily acquires a handle on the first call (open) so schema validation errors throw before allocating a handle.
  let handle: number | undefined;
  const client: Client = new Client((call) => {
    if (handle === undefined) {
      handle = module.start(name);
      clients.set(handle, client);
    }
    module.send(handle, JSON.stringify(call));
  }, options);
  const main = client.open();
  /**
   * Closes the database, waits for the core thread to close the database file before returning, and unsubscribes from incoming messages.
   * Marks the instance closed immediately so reopening under the same name acquires a fresh handle sequenced behind this close.
   */
  const close = () => {
    opened.closed(name, instance);
    return client.close({ type: 'close' }, () => handle !== undefined && clients.delete(handle));
  };
  const instance = syncline(
    name,
    client.local,
    main,
    {
      shared: client.share,
      close,
      delete: async () => {
        await close();
        await module.remove(name);
      },
    },
    token,
  );
  // A database that could not open (e.g. PendingWrites) is closed, so the app can open the name again (e.g. with discardPending).
  client.opening.catch(() => close().catch(() => undefined));
  return instance;
}

/**
 * Synchronizes once during a brief background execution window when awakened by an OS background task.
 *
 * Connects, pushes pending writes, and pulls up to head. Reuses an already-open database in this process if the app remains in memory
 * in the background without closing it; otherwise opens it, syncs, and closes cleanly without leaving idle connections or timers.
 * If the user opens the app during sync, the foreground closes this instance and opens its own, and this resolves. Aborts via signal or failure close
 * opened databases; on iOS background time expiration the app is suspended immediately, which may preclude graceful closure.
 * Synchronizes only the private space. Preserves pending writes regardless of discardPending: switching users while pending writes
 * remain rejects with PendingWrites for resolution in the foreground.
 */
export function syncOnce<S extends Schema>({ discardPending: _, ...options }: OpenOptions<S>, settings: { signal?: AbortSignal } = {}) {
  return opened.syncOnce(options.name, () => open(options), settings);
}
