import initWasm, { type Database, Files } from '../../rust/target/web/syncline_wasm.js';
import wasmUrl from '../../rust/target/web/syncline_wasm_bg.wasm';
import type { Received } from './client.ts';
import { serializeError } from './errors.ts';
import { Shell } from './shell.ts';

/**
 * Hosts synchronization in a dedicated web Worker.
 *
 * Runs the Rust core compiled to WebAssembly alongside the networking and timer shell (Shell). The main page thread only issues calls and
 * receives replies and notifications, offloading all sync operations. Database files are stored in OPFS (exclusive access: {@link Files}).
 * A single Worker serves the entire page: sequential database opens sequence in order. Each open is tagged with a unique instance counter;
 * calls matching the active instance are handled, while calls from closed instances reject with "Local database is closed" without
 * touching the new database. Open and close lifecycles are managed in this layer; other calls are forwarded to the core.
 * What this module must not know: How the page uses the data or table business logic.
 */

/** Message from page: call tagged with instance ID (core inputs plus open and close). */
export type HostMessage = { instance: number; call: { type: string; id?: number } & Record<string, unknown> };
/** Message to page: batched replies/notifications for an instance, unhandled errors serialized from the Worker, or a core panic. */
export type WorkerMessage =
  | { instance: number; received: Received[] }
  | { type: 'error' | 'broken'; error: ReturnType<typeof serializeError> };

const post = (message: WorkerMessage) => self.postMessage(message);

/**
 * Reports an unhandled error to the page; a WebAssembly trap is a Rust panic, after which the core is unusable, so the page discards
 * this Worker (as native hosts deliver broken on panic). Other errors are only reported.
 */
const unhandled = (error: unknown) =>
  post({ type: error instanceof WebAssembly.RuntimeError ? 'broken' : 'error', error: serializeError(error) });

/**
 * Forwards unhandled errors to the page.
 *
 * Unhandled Worker errors trigger error on the page Worker object, causing the page to treat the Worker as crashed; preventing default
 * and posting them allows normal reporting. Unhandled promise rejections do not propagate to the page by default and are likewise
 * forwarded.
 * @see https://html.spec.whatwg.org/multipage/webappapis.html#report-an-exception
 * @see https://html.spec.whatwg.org/multipage/webappapis.html#unhandled-promise-rejections
 */
function forwardErrors() {
  self.addEventListener('error', (event) => {
    event.preventDefault();
    unhandled(event.error ?? event.message);
  });
  self.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    unhandled(event.reason);
  });
}

/** Loads wasm and mounts OPFS; rejects if another tab (its Worker) holds the database file. */
async function load() {
  await initWasm({ module_or_path: wasmUrl });
  try {
    return await Files.install();
  } catch (error) {
    if (error instanceof Error && error.message.includes('NoModificationAllowedError'))
      throw new Error('Local database is open in another tab: web supports only one tab at a time; close other tabs and reload');
    throw error;
  }
}

/** Open database state. */
type Opened = { instance: number; name: string; db: Database; shell: Shell };

/** Formats core errors: wasm initialization errors serialize core failure JSON. */
const failureOf = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('{') ? JSON.parse(message) : serializeError(error);
};

forwardErrors();
const files = load();
let open: Opened | undefined;

/** Closes the active database: stops sync, closes sockets and timers, and releases database files. */
function closeOpen() {
  if (!open) return;
  open.shell.send({ type: 'close' });
  open.shell.close();
  open.db.free();
  open = undefined;
}

/** Opens database: closes any active unclosed database first, rejecting subsequent calls to prevent dangling sync state. */
async function openLibrary(instance: number, name: string, options: unknown) {
  closeOpen();
  const db = (await files).open(name);
  const host = { randomUUID: () => crypto.randomUUID(), random: Math.random };
  let instructions: string;
  try {
    instructions = db.open(JSON.stringify(options), host, Date.now());
  } catch (error) {
    db.free();
    throw error;
  }
  const shell = new Shell(db, {}, (instruction) => post({ instance, received: [instruction] }));
  open = { instance, name, db, shell };
  return () => shell.begin(instructions);
}

/** Closes database instance, optionally removing database file when requested. */
async function closeLibrary(instance: number, name: string, remove: boolean) {
  if (open?.instance === instance) closeOpen();
  if (!remove) return;
  if (open?.name === name) throw new Error(`Local database ${name} is still open from another session: close it before deleting`);
  (await files).remove(name);
}

async function handle(instance: number, call: HostMessage['call']) {
  const reply = (error?: unknown) =>
    post({ instance, received: [{ type: 'reply', id: call.id ?? 0, ...(error !== undefined && { error: failureOf(error) }) }] });
  if (call.type === 'open' || call.type === 'close') {
    try {
      // Replies to open call first, then executes buffered opening instructions (issues and space statuses follow reply).
      const begin =
        call.type === 'open'
          ? await openLibrary(instance, call.name as string, call.options)
          : await closeLibrary(instance, call.name as string, call.remove === true);
      reply();
      begin?.();
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) throw error;
      reply(error);
    }
    return;
  }
  if (open?.instance === instance) return open.shell.send(call);
  if (call.id !== undefined) reply(new Error('Local database is closed'));
}

/** Serializes open, close, and core calls sequentially in arrival order; unhandled errors report to the page while processing continues. */
let queue = Promise.resolve();
self.onmessage = ({ data: { instance, call } }: MessageEvent<HostMessage>) => {
  queue = queue.then(() => handle(instance, call)).catch(unhandled);
};
