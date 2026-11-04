import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Poke } from '../common/protocol.ts';
import { Device, type Shared } from '../test/test-device.ts';
import { Local, None, Ownership, P } from '../test/test-ownership.ts';
import { random } from '../test/test-random.ts';
import { picker, takeStep } from '../test/test-skeleton.ts';
import { deviceStorage } from '../test/test-storage.ts';

// Ownership simulation: a random seed picks the actions of model/Ownership.tla (opening the private space with any owner,
// declaration, and local-only tables; opening shared spaces, some failing after their owner switch; pulls; local-only writes;
// closing) and drives the Rust device with them. Row ids carry the space and owner they came from, so after every step the rows
// each table holds are checked against the model: the same sources as the reference state, `NoLeak` and `Exact` on the rows
// themselves, and a cookie exactly where the model keeps one.
// @see https://apple.github.io/foundationdb/testing.html

const names = ['a', 'b', 'c'];
const spaces = ['s1', 's2'];
const users = ['u1', 'u2', None];
const table = (name: string) => sqliteTable(name, { id: text().primaryKey() });
// A release changing a column type: the table exists with text keys, so opening fails after the owner switch
const retyped = (name: string) => sqliteTable(name, { id: integer().primaryKey() });

type Mirror = Device['private'] | Shared;

/** Whether the space's next pull continues from its cookie (a refetch keeps the cookie but pulls in full, as the cloud does). */
const incremental = (mirror: Mirror) => {
  const { cookie, refetch } = mirror.pullRequest();
  return cookie !== null && refetch !== true;
};

class Simulation {
  readonly steps: string[] = [];
  readonly #model = new Ownership(names, spaces);
  readonly #storage = deviceStorage(...names.map((name) => `CREATE TABLE ${name} (id TEXT PRIMARY KEY)`));
  readonly #random: () => number;
  readonly #pick: ReturnType<typeof picker>;
  #device: Device | undefined;
  /** Spaces opened in this session. */
  readonly #mirrors = new Map<string, Mirror>();
  /** Shared spaces declared in this session, and their tables: the device keeps both even when opening fails, so unlike the model, a failed space is not opened again until the next session. */
  readonly #declared = new Map<string, string[]>();
  #rows = 0;

  constructor(seed: number) {
    this.#random = random(seed);
    this.#pick = picker(this.#random);
  }

  async step() {
    if (this.#model.phase === 'closed') {
      this.#openPrivate();
      return this.check();
    }
    const taken = new Set([...this.#model.taken(), ...[...this.#declared.values()].flat()]);
    const free = names.filter((name) => !taken.has(name));
    const unopened = spaces.filter((space) => !this.#declared.has(space));
    const pulling = [...this.#mirrors.keys()].filter((space) => (this.#model.decl.get(space) as Set<string>).size > 0);
    const actions: [number, () => Promise<void>][] = [
      [free.length > 0 && unopened.length > 0 ? 2 : 0, () => this.#openShared(this.#pick(unopened) as string, free)],
      [pulling.length > 0 ? 4 : 0, () => this.#pull(this.#pick(pulling) as string)],
      [this.#model.local.size > 0 ? 2 : 0, () => this.#localWrite(this.#pick([...this.#model.local]) as string)],
      [1, async () => this.#close()],
    ];
    await takeStep(this.#pick, actions, undefined, async () => this.check());
  }

  #subset(from: string[], odds: number) {
    return from.filter(() => this.#random() < odds);
  }

  #openPrivate() {
    const owner = this.#pick(users) as string;
    // The private space declares few tables, so shared spaces often declare tables no space synced yet
    const synced = this.#subset(names, 0.25);
    const localOnly = this.#subset(
      names.filter((name) => !synced.includes(name)),
      0.4,
    );
    this.steps.push(`openPrivate(${owner}, [${synced}], local [${localOnly}])`);
    this.#device = new Device(this.#storage, synced.map(table), { ...(owner !== None && { owner }), localOnly: localOnly.map(table) });
    this.#model.openPrivate(owner, new Set(synced), new Set(localOnly));
    this.#mirrors.set(P, this.#device.private);
  }

  async #openShared(space: string, free: string[]) {
    const owner = this.#pick(users) as string;
    const declared = this.#subset(free, 0.5);
    if (declared.length === 0) declared.push(this.#pick(free) as string);
    const fails = this.#random() < 0.2;
    this.steps.push(`openShared(${space}, [${declared}], ${owner}${fails ? ', fails' : ''})`);
    const tables = declared.map((name, index) => (fails && index === 0 ? retyped(name) : table(name)));
    const mirror = (this.#device as Device).shared(space, tables, owner === None ? undefined : owner);
    this.#declared.set(space, declared);
    if (fails) {
      await expect(mirror.opened()).rejects.toThrow();
    } else {
      await mirror.opened();
      this.#mirrors.set(space, mirror);
    }
    this.#model.openShared(space, new Set(declared), owner, fails);
  }

  /** The space pulls a row for every table, including ones it does not declare (kept as unknown rows); without a cookie, it pulls in full. */
  async #pull(space: string) {
    const mirror = this.#mirrors.get(space) as Mirror;
    const { cookie: base } = mirror.pullRequest();
    const full = !incremental(mirror);
    const source = `${space}|${this.#model.ownerOf(space)}`;
    this.steps.push(`pull(${space}) ${full ? 'full' : 'incremental'} as ${source}`);
    const puts = names.map((name) => {
      const id = `${source}|${++this.#rows}`;
      return { op: 'put' as const, table: name, key: { id }, row: { id } };
    });
    const version = (base?.version ?? 0) + 1;
    const poke: Poke = { base, cookie: { version, nonce: ++this.#rows }, lmids: {}, patch: full ? [{ op: 'clear' }, ...puts] : puts };
    expect(await mirror.receive(poke)).toBe(true);
    this.#model.pull(space);
  }

  async #localWrite(name: string) {
    const id = `${Local}|${this.#model.privOwner}|${++this.#rows}`;
    this.steps.push(`localWrite(${name}) ${id}`);
    await (this.#device as Device).write(async (execute) => execute(`INSERT INTO ${name} (id) VALUES (?)`, [id]));
    this.#model.localWrite(name);
  }

  #close() {
    this.steps.push('close');
    this.#device?.close();
    this.#model.close();
    this.#mirrors.clear();
    this.#declared.clear();
  }

  /** Checks the rows and cookies the device holds against the model. */
  check() {
    this.#model.noLeak();
    this.#model.exact();
    const held = new Map(
      names.map((name) => {
        const ids = this.#storage.sql.exec(`SELECT id FROM ${name}`).toArray() as { id: string }[];
        return [name, new Set(ids.map(({ id }) => id.slice(0, id.lastIndexOf('|'))))];
      }),
    );
    this.#model.noLeak(held);
    this.#model.exact(held);
    // Row ids carry the owner a space pulled them for, while the model tags the private space's unknown rows with its owner after
    // the open (the same one, unless no owner was recorded when they were pulled), so compare sources only
    const sources = (content: Map<string, Set<string>>) =>
      Object.fromEntries([...content].map(([name, tags]) => [name, [...new Set([...tags].map((tag) => tag.split('|')[0]))].sort()]));
    expect(sources(held)).toEqual(sources(this.#model.content));
    for (const [space, mirror] of this.#mirrors) expect([space, incremental(mirror)]).toEqual([space, this.#model.cookie.get(space)]);
  }
}

test.for(Array.from({ length: 500 }, (_, index) => Number(process.env.SIMULATION_SEED ?? 0) + index))(
  'ownership simulation seed %i: rows match model/Ownership.tla after every step',
  async (seed) => {
    const simulation = new Simulation(seed);
    try {
      for (let step = 0; step < 60; step++) await simulation.step();
    } catch (error) {
      throw new Error(`seed ${seed} failed after:\n${simulation.steps.join('\n')}`, { cause: error });
    }
  },
);
