import { notifyAll } from '../common/listeners.ts';
import { abortable } from '../expo/client.ts';
import type { SyncStatus } from '../expo/status.ts';
import type { ConnectionOptions, Mirror } from './test-device.ts';
import type { Calls } from './test-rust.ts';

// Rust 设备上一个空间的同步当作 Connection 用：start、stop、sync 这些调用经 Shell 交给 Rust，同步状态由 Rust 报来

/** Rust 设备上一个空间的同步，接口同 Connection：调用经 Shell 交给 Rust，同步状态是 Rust 报来的最近一次 */
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

  /** 没有这个空间的同步（关了库）时 Rust 回错：TS 那边什么也不做，这里也不理 */
  reconnect() {
    this.#calls.call({ type: 'reconnect', channel: this.#channel }).catch(() => undefined);
  }
}
