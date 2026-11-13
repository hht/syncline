import { report } from '../listeners.ts';
import { Client } from './client.ts';
import { deserializeError } from './errors.ts';
import { type OpenOptions, type Schema, syncline } from './syncline.ts';
import type { HostMessage, WorkerMessage } from './worker.ts';

export * from './public.ts';

/**
 * Opens Syncline in web applications with sync and storage running in a dedicated Worker.
 *
 * The dedicated Worker runs the Rust sync engine compiled to WebAssembly. The main page thread only issues calls and
 * receives replies and notifications without blocking the UI thread.
 * A single Worker serves the entire page: OPFS allows only one open connection per file, so sequential database opens
 * sequence open and close within the same Worker.
 * Each open assigns a unique instance number carried on every request and response to route messages strictly to the matching Client.
 * What this module must not know: Storage layout or internal sync protocol details.
 */

let worker: Worker | undefined;
let nextInstance = 0;
/** Active database instances receiving messages from the Worker; closed instances are removed. */
const instances = new Map<number, Client>();

/**
 * Handles unrecoverable Worker failure (worker script load error, asset missing after redeployment, unparseable message, or core panic).
 *
 * Fails all pending calls across active instances with the error and marks downloadError on sync status to prevent indefinite stalls.
 * Discards the broken Worker and instances so subsequent calls instantiate a fresh Worker.
 * @see https://html.spec.whatwg.org/multipage/workers.html#handler-abstractworker-onerror
 */
function broken(error: Error) {
  worker?.terminate();
  worker = undefined;
  for (const client of instances.values()) client.broken(error);
  instances.clear();
}

function post(message: HostMessage) {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url));
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if ('type' in data)
        return data.type === 'broken'
          ? broken(new Error(`Syncline core panicked: ${data.error.message}`))
          : report(deserializeError(data.error));
      instances.get(data.instance)?.receive(data.received);
    };
    worker.onerror = (event) => broken(new Error(`Syncline worker error: ${event.message || 'failed to load'}`));
    worker.onmessageerror = () => broken(new Error('Failed to deserialize message from Syncline worker'));
  }
  worker.postMessage(message);
}

/** Opens or creates a local database and starts synchronizing its private space. */
export function openSyncline<S extends Schema>(options: OpenOptions<S>) {
  const { name } = options;
  const instance = nextInstance++;
  const client = new Client((call) => post({ instance, call }), options);
  // Registered after open, which throws on invalid options before anything is posted; replies arrive asynchronously
  const main = client.open({ name });
  instances.set(instance, client);
  /** Closes database and unsubscribes this instance from worker messages. */
  const close = () => client.close({ type: 'close', name, remove: false }, () => instances.delete(instance));
  /** Deletes database: awaits close, then issues a dedicated removal instance to delete database file. */
  const remove = async () => {
    await close();
    const removal = nextInstance++;
    const remover = new Client((call) => post({ instance: removal, call }), options);
    instances.set(removal, remover);
    await remover.call<void>({ type: 'close', name, remove: true }).finally(() => instances.delete(removal));
  };
  return syncline(name, client.local, main, { shared: client.share, close, delete: remove }, options.token);
}
