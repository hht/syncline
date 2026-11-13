import { type Change, sameCookie } from '../../src/protocol/messages.ts';
import type { Storage } from '../../src/sqlite/storage.ts';
import { Device } from './test-checksum.ts';
import { head } from './test-commits.ts';
import { createMemo, labelsOf, type Releases, schema, writes } from './test-counter.ts';
import type { Network } from './test-network.ts';
import { started } from './test-skeleton.ts';
import type { Trace } from './test-sockets.ts';
import { deviceStorage, restoredDeviceStorage, restoredStorage } from './test-storage.ts';
import type { Connection } from './test-sync.ts';
import type { Message, Tracer } from './test-trace.ts';

// Deterministic simulation device fleet: each device owns a local database, real Device and Connection;
// process launch, crash restarts, backgrounding, system backups and restores, long-running local writes and queued messages;
// checks convergence and push progress. Action scheduling driven by simulation harness; model actions recorded to trace.

const url = 'https://sync.test/space';

/** Open local write per device (executed but not committed): incoming notifications queue behind it until committed. */
class OpenWrites {
  readonly #open = new Map<number, { close: () => void; done: Promise<unknown> }>();

  has(index: number) {
    return this.#open.has(index);
  }

  indexes() {
    return [...this.#open.keys()];
  }

  /** Starts open write incrementing counter: waits for close() before committing; invokes committed() unless rolled back on close. */
  open(index: number, device: Device, id: string, label: string, committed: () => void) {
    if (this.#open.has(index)) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#open.set(index, { close: resolve, done: writes.inc(device, id, label, promise).then(committed, () => undefined) });
  }

  async close(index: number) {
    const open = this.#open.get(index);
    this.#open.delete(index);
    open?.close();
    await open?.done;
  }

  /** Process terminated: open write rolls back on database close. */
  forget(index: number) {
    this.#open.delete(index);
  }
}

export class SimulatedDevices {
  readonly devices: Device[] = [];
  readonly #storages: ReturnType<typeof deviceStorage>[];
  readonly #connections: Connection[] = [];
  // Single backup slot per model: subsequent backups overwrite.
  #image: Uint8Array | undefined;
  readonly #open = new OpenWrites();
  /** Trace validation: incoming messages queued behind open writes per device. */
  readonly #deferred: { optional?: boolean; message?: Message }[][] = [];
  readonly #network: Network;
  readonly #releases: Releases;
  readonly #tracer: Tracer | undefined;
  readonly #random: () => number;

  /** Launches count devices. */
  constructor(count: number, network: Network, releases: Releases, tracer: Tracer | undefined, random: () => number) {
    this.#network = network;
    this.#releases = releases;
    this.#tracer = tracer;
    this.#random = random;
    this.#storages = Array.from({ length: count }, () => deviceStorage(...schema, createMemo));
    for (const index of this.#storages.keys()) this.start(index);
  }

  /** Records network event in trace: messages arriving while write is open queue until write closes. */
  traced(tracer: Tracer, ...[name, index, options]: Parameters<Trace>) {
    // Cloud-to-device Sent events only tracked for shared spaces; private space model delivers in cloud step.
    if (name === 'Sent') return;
    if (name === 'Recv' && this.#open.has(index)) this.#deferred[index] = [...(this.#deferred[index] ?? []), options ?? {}];
    else tracer.add(name, index, options);
  }

  storage(index: number) {
    return this.#storages[index] as Storage;
  }

  /** Whether device is connected according to sync status. */
  connected(index: number) {
    return this.#connections[index]?.status().connected === true;
  }

  /**
   * Starts device: crash restarts and backup restores instantiate fresh Device and Connection;
   * restart specifies corresponding model action (undefined on initial startup).
   */
  start(index: number, restart?: 'Crash' | 'RestoreBackup') {
    if (restart) this.#tracer?.add(restart, index);
    this.#connections[index]?.stop();
    // Process terminated: open local write rolls back.
    this.devices[index]?.close();
    this.#open.forget(index);
    this.#discardDeferred(index);
    this.#network.disconnect(index);
    const device = new Device(this.#storages[index] as ReturnType<typeof deviceStorage>, ...this.#releases.install(index));
    this.devices[index] = device;
    this.#connections[index] = started(device.private, url, this.#network, index, this.#random);
  }

  /** App enters background then returns: stops then restarts Connection; invalidates active connection. */
  background(index: number) {
    this.#connections[index]?.stop();
    this.#discardDeferred(index);
    this.#connections[index]?.start();
  }

  /**
   * Drops messages queued behind open writes when process or connection is invalidated;
   * recorded as Drop in model trace so subsequent pulls are not considered in-flight.
   */
  #discardDeferred(index: number) {
    for (const options of this.#deferred[index] ?? []) {
      const socket = options.message?.t === 'poke' || options.message?.t === 'hint';
      this.#tracer?.add('Drop', index, socket ? { ...options, optional: true } : options);
    }
    this.#deferred[index] = [];
  }

  /** Backs up device database image (single backup slot; overwrites prior). */
  backup(index: number) {
    this.#image = this.#storages[index]?.image();
    this.#tracer?.add('Backup', index);
  }

  /** Tag labels attached to pending writes in backup image (surviving PITR if device restores from backup). */
  backupLabels() {
    if (!this.#image) return [];
    const backup = restoredStorage(this.#image);
    return backup.sql
      .exec('SELECT changes FROM _syncline_pending')
      .toArray()
      .flatMap(({ changes }) => labelsOf([{ client: '', id: 0, changes: JSON.parse(String(changes)) as Change[] }]));
  }

  /** Restores device from backup (acts as clone if restoring across devices); returns false if no backup exists. */
  restore(index: number) {
    if (!this.#image) return false;
    this.#storages[index] = restoredDeviceStorage(this.#image);
    this.#image = undefined;
    this.start(index, 'RestoreBackup');
    return true;
  }

  /** Whether device has an open local write; lists device indexes with open writes. */
  opened(index: number) {
    return this.#open.has(index);
  }

  openIndexes() {
    return this.#open.indexes();
  }

  /** Opens long-running local write: queues subsequent notifications until closed; rolls back if restarted mid-write. */
  open(index: number, id: string, label: string, written: () => void) {
    const device = this.devices[index] as Device;
    this.#open.open(index, device, id, label, () => this.devices[index] === device && written());
  }

  /** Closes open write on device: delivers queued incoming messages. */
  async close(index: number) {
    const deferred = this.#deferred[index] ?? [];
    this.#deferred[index] = [];
    await this.#open.close(index);
    for (const options of deferred) this.#tracer?.add('Recv', index, options);
  }

  /** Asserts pushes do not stall: connected caught-up devices with idle network must not hold pending writes. */
  checkPushing() {
    for (const [index, device] of this.devices.entries()) {
      // Devices with open writes queue notifications behind the write.
      const connected = this.connected(index) && !this.#network.silent(index) && !this.#open.has(index);
      if (connected && !device.private.behind() && device.private.pending().length > 0)
        throw new Error(`device ${index} connected but stalled with ${device.private.pending().length} pending writes`);
    }
  }

  /** Convergence: upload queue empty, caught up (checksum verified), cookie matches cloud head, state equals cloud. */
  converged(cloud: Storage) {
    return this.devices.every(
      (device, index) =>
        device.private.pendingCount() === 0 &&
        !device.private.behind() &&
        sameCookie(device.private.cookie(), head(cloud)) &&
        this.#releases.same(index, this.storage(index), cloud),
    );
  }
}
