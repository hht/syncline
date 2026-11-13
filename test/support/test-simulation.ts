import { join } from 'node:path';
import { expect } from 'vitest';
import { protocolVersion } from '../../src/protocol/version.ts';
import { SimulatedCloud, seams } from './test-cloud.ts';
import { decided, WriteLedger } from './test-commits.ts';
import { keys, labelsOf, Releases, writes } from './test-counter.ts';
import type { Device } from './test-device.ts';
import { SimulatedDevices } from './test-devices.ts';
import { flush } from './test-drive.ts';
import { privateCloud } from './test-entry.ts';
import { Network } from './test-network.ts';
import { random } from './test-random.ts';
import { garbled } from './test-requests.ts';
import { picker, settle, simulated, takeStep } from './test-skeleton.ts';
import { injectedPrefix } from './test-storage.ts';
import { Tracer } from './test-trace.ts';

// Deterministic simulation: a random seed dictates all writes, message arrival order, timers, and faults;
// any failure is fully reproducible by re-running with the seed from the test title (controlled via SIMULATION_SEED).
// Runs real Server and Connection instances with test doubles for tokens, WebSocket, HTTP, and timers.
// Token quirks: acquisition failures, expired tokens, active renewals; in-flight responses deliver with latency.
// Faults: garbled payloads (triggering disconnect and recovery), protocol rollback and re-deployment,
// storage faults causing actor resets while preserving committed writes, and concurrent server writes.
// Sized with small chunk limits to force chunked pagination and HTTP fallbacks.
// Device writes include counter increments, tags (rejected if counter concurrently deleted), and deletions (cascading tags).
// Asserts model invariants: P1 at-most-once decision, P5 local database = cloud at cookie + replay pending writes,
// P7 no confirmed writes in pending queue, P8r rolled back writes without surviving replicas do not revive,
// P8k lost writes are strictly those rolled back by PITR, P6/P9 convergence post-faults, and at-most-one connection per device.
// @see https://apple.github.io/foundationdb/testing.html

export class Simulation {
  /** Devices: process lifecycle, local storage, and open writes. */
  readonly #devices: SimulatedDevices;
  readonly #random: () => number;
  readonly #pick: ReturnType<typeof picker>;
  readonly #faults: { backups: boolean; restores: boolean };
  readonly #network: Network;
  /** Cloud: actor and associated fault handlers. */
  readonly #cloud: SimulatedCloud;
  /** Whether writes were lost due to device backup restore (disabling decision equality check). */
  lost = false;
  /** Tracks writes lost strictly due to cloud PITR rollback. */
  readonly #ledger = new WriteLedger();
  /** Count of local writes created that mutated state. */
  created = 0;
  #labels = 0;
  readonly releases = new Releases();
  /** Tracer recording model actions during trace validation; undefined otherwise. */
  readonly #tracer: Tracer | undefined;
  /** Maximum cloud PITR restores (1 for trace validation matching MaxRestores, up to 3 otherwise). */
  readonly #maxRestores: number;

  constructor(
    seed: number,
    { devices, tracer, ...faults }: { devices: number; backups: boolean; restores: boolean; tracer?: Tracer | undefined },
  ) {
    this.#random = random(seed);
    this.#pick = picker(this.#random);
    this.#tracer = tracer;
    this.#maxRestores = tracer ? 1 : 3;
    this.#network = new Network(
      (items) => this.#pick(items),
      () => privateCloud(this.#cloud.server),
      () => this.#cloud.deploy(),
    );
    this.#network.trace = tracer && ((...event) => this.#devices.traced(tracer, ...event));
    this.#network.seams = seams((index) => this.storage(index));
    this.#cloud = new SimulatedCloud(this.#network, this.releases, tracer, this.#random, (before, at) => {
      this.#ledger.rewound(
        before,
        at,
        this.devices.map((_, index) => this.storage(index)),
      );
      return new Set([...this.devices.flatMap((device) => labelsOf(device.private.pending())), ...this.#devices.backupLabels()]);
    });
    this.#faults = faults;
    this.#devices = new SimulatedDevices(devices, this.#network, this.releases, tracer, this.#random);
    this.#tracer?.step('start');
  }

  /** Cloud database storage. */
  get cloud() {
    return this.#cloud.storage;
  }

  get devices() {
    return this.#devices.devices;
  }

  storage(index: number) {
    return this.#devices.storage(index);
  }

  /** Steps simulation: write, delivery, handshake, HTTP roundtrip, timer fire, or fault. */
  async step() {
    const device = Math.floor(this.#random() * this.devices.length);
    const actions: [number, () => unknown][] = [
      [16, () => this.#write(device, writes.inc)],
      [10, () => this.#write(device, writes.mark)],
      [4, () => this.#write(device, (on, id) => writes.remove(on, id))],
      [4, () => this.#openWrite(device)],
      [6, () => this.#devices.close(device)],
      [3, () => this.#cloud.serverWrite(this.#label())],
      [this.releases.notes(device) ? 6 : 0, () => this.#write(device, writes.note)],
      [this.releases.cloudOnly() ? 3 : 0, () => this.releases.cloudNote(this.cloud, this.#pick(keys) as string, this.#label())],
      [this.releases.more() ? 2 : 0, () => this.#cloud.release()],
      [80, () => this.#network.deliver()],
      [16, () => this.#network.handshake()],
      [12, () => this.#network.respond()],
      [12, () => this.#network.arrive()],
      [14, () => this.#network.fire()],
      [8, () => this.#network.breakOne()],
      [4, () => this.#network.silenceOne()],
      [4, () => this.#network.failOne()],
      [2, () => this.#network.garbleOne()],
      [2, () => this.#cloud.fail()],
      [4, () => this.#devices.start(device, 'Crash')],
      [4, () => this.#devices.background(device)],
      [2, () => this.#cloud.deploy()],
      [3, () => this.#cloud.truncate()],
      // Cloud protocol rolls back to prior version then deploys back: device detects outdated cloud and backs off.
      [1, () => this.#cloud.deployProtocol()],
      // Backup captures committed state: active open writes omitted.
      [this.#faults.backups && !this.#devices.opened(device) ? 3 : 0, () => this.#devices.backup(device)],
      [this.#faults.backups ? 3 : 0, () => this.#restoreDevice(device)],
      // Cloud PITR can fire repeatedly.
      [this.#faults.restores && this.#cloud.restores < this.#maxRestores ? 2 : 0, () => this.#cloud.restore()],
    ];
    await takeStep(this.#pick, actions, this.#tracer, () => this.#after());
  }

  /** Drains network post-faults until convergence; checks push progress before firing timers. */
  async settle() {
    this.#tracer?.step('settle');
    await this.#stopFaults();
    await settle({
      network: this.#network,
      pick: this.#pick,
      tracer: this.#tracer,
      converged: () => this.#devices.converged(this.cloud),
      after: () => this.#after(),
      beforeFire: () => this.#devices.checkPushing(),
    });
  }

  /** Halts all faults: clears storage faults, redeploys protocol, commits open writes, upgrades outdated devices. */
  async #stopFaults() {
    this.#cloud.calm();
    if (this.#network.cloudVersion !== protocolVersion) this.#cloud.deployProtocol(protocolVersion);
    for (const index of this.#devices.openIndexes()) await this.#devices.close(index);
    for (const index of this.devices.keys()) if (this.releases.outdated(index)) this.#devices.start(index, 'Crash');
    // Closing open writes processes deferred messages (potentially issuing pulls) before checking idle.
    await this.#after();
  }

  async #after() {
    await flush();
    this.#network.seams?.check();
    this.#tracer?.observe(
      this.devices,
      this.devices.map((_, index) => this.storage(index)),
      this.cloud,
    );
    this.#cloud.history.record(this.cloud);
    this.#ledger.observe(
      this.cloud,
      this.devices.map((_, index) => this.storage(index)),
    );
    for (const index of this.devices.keys()) {
      this.#check(index);
      // At most one connection per device simultaneously (model invariant).
      if (this.#network.live(index) > 1) throw new Error(`device ${index} has ${this.#network.live(index)} concurrent active connections`);
    }
    this.#cloud.check();
    if (this.#network.ready().length === 0) this.#devices.checkPushing();
  }

  /** Restores device from backup: marks write loss. */
  #restoreDevice(index: number) {
    if (!this.#devices.restore(index)) return;
    this.lost = true;
    this.#ledger.restored(index);
  }

  /** Initiates write on device with globally unique tag label. */
  async #write(index: number, write: (device: Device, id: string, label: string) => Promise<boolean>) {
    // Queued behind open local write; non-blocking in this step.
    if (this.#devices.opened(index)) return;
    const label = this.#label();
    const device = this.devices[index] as Device;
    if (await write(device, this.#pick(keys) as string, label)) this.#written(index);
  }

  /** Records committed state-mutating write. */
  #written(index: number) {
    this.created += 1;
    this.#tracer?.add('Mutate', index);
  }

  /** Initiates long-running local write: queues incoming notifications until closed; rolls back on restart. */
  #openWrite(index: number) {
    const label = this.#label();
    this.#devices.open(index, this.#pick(keys) as string, label, () => this.#written(index));
  }

  #label() {
    this.#labels += 1;
    return `t${this.#labels}`;
  }

  /** P5, P7: local database = cloud at cookie + replay pending writes; pending writes must not be confirmed by cookie. */
  #check(index: number) {
    // Open local write uncommitted: P5 checked once committed.
    if (this.#devices.opened(index)) return;
    const device = this.devices[index] as Device;
    this.#cloud.history.check(device.private.cookie(), device.private.pending(), this.storage(index));
  }

  /**
   * Post-convergence checksum verification: pulls checksum ranges sequentially (verifying local ranges),
   * proceeding until final range completes or verification aborts.
   */
  async verify(index: number) {
    const device = this.devices[index] as Device;
    const next = () => this.storage(index).sql.exec("SELECT next FROM _syncline_verified WHERE space = ''").toArray()[0]?.next;
    for (let round = 0; round < 100; round += 1) {
      // Prior verification round finishes first (invalidated connections abort cleanly).
      await this.#resume();
      const checksum = String(next() ?? '');
      await device.private.receive(JSON.parse(this.#cloud.server.pull({ ...device.private.pullRequest(), checksum })));
      let done = false;
      const verified = device.private.verify().finally(() => {
        done = true;
      });
      await this.#resume(() => done);
      const matched = await verified;
      if (matched !== true || typeof next() !== 'string') return matched;
    }
    throw new Error('checksum verification exceeded 100 ranges without completing');
  }

  /**
   * Drains 0ms timers on mock network until done condition met:
   * Rust device yields thread between batches via 0ms timers.
   */
  async #resume(done = () => true) {
    while (this.#network.fire(0) || !done()) await new Promise((resolve) => setImmediate(resolve));
  }

  /** Upkeep: truncates the commit log until it is within its cap; returns the databases and network state left. */
  upkeep() {
    while (this.#cloud.truncate());
    return {
      cloud: this.cloud,
      devices: this.devices.map((_, index) => this.storage(index)),
      network: { timers: this.#network.timers.size, accepted: this.#network.accepted.size },
    };
  }

  /** Total writes rolled back by cloud PITR. */
  get rolledBack() {
    return this.#ledger.lost;
  }
}

/** Faults a seed enables: odd seeds back up and restore devices, seeds 2 and 3 mod 4 restore the cloud to a point in time. */
const faults = (seed: number) => ({ backups: seed % 2 === 1, restores: seed % 4 >= 2 });

/** Seeds enabling the given faults, one test file per partition so the partitions run in parallel. */
export function seeds({ backups, restores }: { backups: boolean; restores: boolean }) {
  const first = Number(process.env.SIMULATION_SEED ?? 0);
  return Array.from({ length: 200 }, (_, index) => first + index).filter(
    (seed) => faults(seed).backups === backups && faults(seed).restores === restores,
  );
}

/**
 * Runs a deterministic simulation seed: 300 steps, halts faults, verifies convergence and post-conditions.
 * Records traces for model/TracePrivate.tla when SIMULATION_TRACE directory is set.
 */
export async function simulate(seed: number) {
  const traces = process.env.SIMULATION_TRACE;
  const tracer = traces ? new Tracer() : undefined;
  const simulation = await simulated(
    () => new Simulation(seed, { devices: 3, ...faults(seed), tracer }),
    () => {
      if (traces) tracer?.write(join(traces, String(seed)));
    },
    // Corrupted frames and injected storage faults report normally; other errors represent bugs.
    (message) => message.includes(garbled) || message.startsWith(injectedPrefix),
  );

  for (const [index, device] of simulation.devices.entries()) {
    const cloud = simulation.releases.view(simulation.cloud, index);
    expect(device.private.pending()).toEqual([]);
    expect([simulation.releases.view(simulation.storage(index), index), await simulation.verify(index)]).toEqual([cloud, true]);
  }
  // Device writes decided exactly once (committed or held) unless lost to cloud PITR; seeds with backup restores omit count check.
  if (simulation.lost) return;
  expect(decided(simulation.cloud)).toBe(simulation.created - simulation.rolledBack);
}
