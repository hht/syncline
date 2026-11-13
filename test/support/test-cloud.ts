import { Server } from '../../src/cloud/server.ts';
import { socketLimit } from '../../src/common/protocol.ts';
import type { Storage } from '../../src/common/storage.ts';
import { protocolVersion } from '../../src/common/version.ts';
import { Seams } from './test-bounds.ts';
import { Space } from './test-checksum.ts';
import { decidedTwice, head, recordDecisions } from './test-commits.ts';
import { CloudHistory, createMemo, keys, labelsIn, type Releases, RevivalCheck, schema, serverInc } from './test-counter.ts';
import type { CloudEnd, Network } from './test-network.ts';
import { cloudStorage, InjectedFault, isInjected, restoredStorage } from './test-storage.ts';
import type { Tracer } from './test-trace.ts';

// Cloud simulation for deterministic tests: a private space object (production Server and Space) and events occurring on it:
// storage faults, deployments, protocol rollbacks, releases, point-in-time recovery, and server writes.
// Scheduling is driven by the simulation harness; corresponding model actions are recorded into trace.

/** Approximate chunk size in characters: full and incremental pulls split across multiple chunks. */
const chunkLimit = 400;

/** Commit log floor limit: reports zero database size so floor acts as threshold, truncating every ~10 writes. */
export const commitFloor = 600;

/** Push row batch limit: set to 2 so multi-mutation pushes process prefixes and clients push remainders. */
const pushRows = 2;

/** Message bounds for the sizes this cloud configures; storage gives a device's database, whose pending writes' clients its pulls list. */
export function seams(storage: (device: number) => Storage) {
  const pending = (device: number) =>
    storage(device)
      .sql.exec('SELECT DISTINCT client FROM _syncline_pending')
      .toArray()
      .map(({ client }) => String(client));
  return new Seams({
    chunk: chunkLimit,
    // {@link Server} caps WebSocket messages at the smaller of its chunk limit and socketLimit.
    socket: Math.min(chunkLimit, socketLimit),
    tables: ['counter', 'tag', 'memo'],
    // Counter and memo ids are single letters and tag ids are labels t<n>: 16 characters hold labels below 10^15.
    key: { id: 't'.padEnd(16, '9') },
    pushRows,
    pending: (device) => new Set(pending(device)),
  });
}

export class SimulatedCloud {
  storage = cloudStorage(...schema, createMemo);
  server: Server<CloudEnd>;
  #space: Space;
  /** Snapshots of each cloud version (used by P5 to verify device state). */
  readonly history = new CloudHistory();
  /** Point-in-time recovery count; P8r verifies rolled-back unheld writes do not revive. */
  restores = 0;
  readonly revival = new RevivalCheck();
  /** Injected storage fault countdown: throws fault after executing N statements; 0 means no fault. */
  #fault = 0;
  readonly #network: Network;
  readonly #releases: Releases;
  readonly #tracer: Tracer | undefined;
  readonly #pick: <T>(items: T[]) => T | undefined;
  readonly #random: () => number;
  /** Timeline rollback tracking: records lost writes that must not revive (WriteLedger, RevivalCheck). */
  readonly #rewound: (before: Storage, at: number) => Set<string>;

  constructor(
    network: Network,
    releases: Releases,
    tracer: Tracer | undefined,
    random: () => number,
    rewound: (before: Storage, at: number) => Set<string>,
  ) {
    this.#network = network;
    this.#releases = releases;
    this.#tracer = tracer;
    this.#random = random;
    this.#pick = (items) => items[Math.floor(random() * items.length)];
    this.#rewound = rewound;
    [this.#space, this.server] = this.#serve();
    this.history.record(this.storage);
  }

  /**
   * Object (re)start: wraps cloud storage to throw InjectedFault after armed statement countdown.
   * Severe SQLite errors trigger object reset: failing call rejects, connections close, previously committed writes survive.
   */
  #serve() {
    this.#fault = 0;
    const cloud = this.storage;
    const exec = (sql: string, ...bindings: unknown[]) => {
      if (this.#fault > 0 && !/^(SAVEPOINT|RELEASE|ROLLBACK)/.test(sql)) {
        this.#fault -= 1;
        if (this.#fault === 0) throw new InjectedFault(sql);
      }
      const cursor = cloud.sql.exec(sql, ...bindings);
      this.#network.seams?.meter(sql, cursor.rowsWritten);
      return cursor;
    };
    const sql = { exec, databaseSize: 0 };
    const [tables, options] = this.#releases.deployed();
    const space = new Space({ ...cloud, sql }, tables, { ...options, commitFloor, pushRows });
    recordDecisions(cloud);
    return [space, new Server(this.#network.sockets(), space, chunkLimit)] as const;
  }

  /** Injects storage fault: triggers within next 1 to 30 read/write statements. */
  fail() {
    this.#fault = 1 + Math.floor(this.#random() * 30);
  }

  /** Clears injected faults. */
  calm() {
    this.#fault = 0;
  }

  /** Direct invocation on object (server writes): injected storage faults reset object and return false. */
  onObject(call: () => void) {
    try {
      call();
      return true;
    } catch (error) {
      if (!isInjected(error)) throw error;
      this.deploy();
      return false;
    }
  }

  /** Point-in-time recovery: rolls cloud database back to an earlier version on current timeline, restarts actor, closes sockets. */
  restore() {
    const version = this.#pick(this.history.earlier(head(this.storage).version));
    if (version === undefined) return false;
    this.#tracer?.add('Restore', undefined, { k: version });
    const before = this.storage;
    const pending = this.#rewound(before, version);
    this.storage = restoredStorage(this.history.rewind(version));
    this.revival.rewound(labelsIn(before), labelsIn(this.storage), pending);
    this.restores += 1;
    this.deploy(false);
    return true;
  }

  /** Schema release: memo table enters or leaves sync (Enter/Leave in model, accompanied by actor restart). */
  release() {
    this.#tracer?.add(this.#releases.cloudOnly() ? 'Enter' : 'Leave');
    this.#releases.next();
    this.deploy(false);
  }

  /** Deploys cloud running specified protocol version; restarts actor and disconnects all active sockets. */
  deployProtocol(version = this.#network.cloudVersion === protocolVersion ? protocolVersion - 1 : protocolVersion) {
    this.#network.cloudVersion = version;
    this.deploy();
  }

  /** Deploys cloud: restarts actor, disconnects sockets; traced is false when triggered by composite actions (restore, release). */
  deploy(traced = true) {
    if (traced) this.#tracer?.add('Deploy');
    this.#network.restart();
    [this.#space, this.server] = this.#serve();
  }

  /**
   * Maintenance chore: log truncation step (Truncate in model); records new low water mark in trace; resets on storage faults.
   * Returns whether it truncated.
   */
  truncate() {
    const low = () => Number(this.storage.sql.exec('SELECT version FROM _syncline_low').toArray()[0]?.version ?? -1);
    const before = low();
    this.onObject(() => this.#space.truncate());
    if (low() === before) return false;
    this.#tracer?.add('Truncate', undefined, { k: low() });
    this.history.reimage(this.storage);
    return true;
  }

  /** Cloud invariants: P1 each client mutation is decided at most once; P8r rolled-back unheld writes do not revive. */
  check() {
    const [twice] = decidedTwice(this.storage);
    if (twice) throw new Error(`write ${twice} was committed twice`);
    this.revival.check(this.storage);
  }

  /** Server write directly committed via Server.mutate. */
  serverWrite(label: string) {
    // Storage faults leave commit status ambiguous; idempotent retries required in production, omitted here.
    const before = head(this.storage).version;
    this.onObject(() => this.server.mutate((tx) => serverInc(tx, this.#pick(keys) as string, label)));
    if (head(this.storage).version !== before) this.#tracer?.add('BackendWrite');
  }
}
