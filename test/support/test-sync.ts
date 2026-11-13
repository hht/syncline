import { abortable } from '../../src/expo/client.ts';
import type { SyncStatus } from '../../src/expo/status.ts';
import { notifyAll } from '../../src/listeners.ts';
import type { ConnectionOptions, Mirror } from './test-device.ts';
import type { Calls } from './test-rust.ts';

// Device space sync wrapper used as Connection in tests: start, stop, and sync delegate to Rust via Shell; status sinks from Rust.

/** Space sync connection on device, conforming to Connection interface. */
export class Connection {
  readonly #calls: Calls;
  readonly #channel: string;
  readonly #listeners = new Set<(status: SyncStatus) => void>();
  #status!: SyncStatus;

  constructor(mirror: Mirror, options: ConnectionOptions) {
    this.#calls = mirror.calls;
    this.#channel = mirror.channel;
    mirror.attach(mirror.channel, {
      options,
      status: (status) => {
        this.#status = status;
        notifyAll(this.#listeners, status);
      },
    });
  }

  start() {
    this.#calls.shell.send({ type: 'start', channel: this.#channel });
  }

  stop() {
    this.#calls.shell.send({ type: 'stop', channel: this.#channel });
  }

  status(): SyncStatus {
    return this.#status;
  }

  onStatus(listener: (status: SyncStatus) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  sync({ signal }: { signal?: AbortSignal } = {}): Promise<void> {
    return abortable(this.#calls.call({ type: 'sync', channel: this.#channel }), signal);
  }

  resync({ signal, discardPending = false }: { signal?: AbortSignal; discardPending?: boolean } = {}): Promise<void> {
    return abortable(this.#calls.call({ type: 'resync', channel: this.#channel, discardPending }), signal);
  }

  /** When space sync is closed (database closed), Rust returns an error; ignored to match client behavior. */
  reconnect() {
    this.#calls.call({ type: 'reconnect', channel: this.#channel }).catch(() => undefined);
  }
}
