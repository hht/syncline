import { integer, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Poke } from '../../src/common/protocol.ts';
import { tableName } from '../../src/tables/table-definitions.ts';
import { Device, type Shared } from '../support/test-device.ts';
import { Local, None, Ownership, P } from '../support/test-ownership.ts';
import { random, stepped } from '../support/test-random.ts';
import { picker, takeStep } from '../support/test-skeleton.ts';
import { deviceStorage } from '../support/test-storage.ts';

// Ownership simulation: a random seed picks the actions of model/Ownership.tla (opening the private space with any owner,
// declaration, local-only tables, and retired tables; opening shared spaces, some failing after their owner switch; pulls;
// local-only writes; closing; the app dropping a table while closed) and drives the Rust device with them. Declarations also
// misuse names: synced tables declaring retired ones, names differing from a stored table only by case, and a view's or a
// virtual table's; opening must refuse them at the layer they belong to, leaving the database untouched when the private space
// refuses and the other spaces working when a shared one does. Row ids carry the space and owner they came from, so after every
// step the rows each table holds are checked against the model: the same sources as the reference state, `NoLeak` and `Exact`
// on the rows themselves, and a cookie exactly where the model keeps one.
// @see https://apple.github.io/foundationdb/testing.html

const names = ['a', 'b', 'c'];
const spaces = ['s1', 's2'];
const users = ['u1', 'u2', None];
/** Objects that are not tables: declaring them under any case is refused. */
const others = ['CREATE VIEW Shelf AS SELECT 1 AS id', 'CREATE VIRTUAL TABLE notes USING fts5(body)'];
const otherNames = ['Shelf', 'shelf', 'notes', 'NOTES'];
const upper = (name: string) => name.toUpperCase();
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
  readonly #storage = deviceStorage(...names.map((name) => `CREATE TABLE ${name} (id TEXT PRIMARY KEY)`), ...others);
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
      if (this.#random() < 0.15) this.#externalDrop(this.#pick(names) as string);
      else this.#openPrivate();
      return this.check();
    }
    const taken = new Set([...this.#model.taken(), ...[...this.#declared.values()].flat()]);
    const free = names.filter((name) => !taken.has(name) && !this.#model.retired.has(name));
    const unopened = spaces.filter((space) => !this.#declared.has(space));
    const pulling = [...this.#mirrors.keys()].filter((space) => (this.#model.decl.get(space) as Set<string>).size > 0);
    const actions: [number, () => Promise<void>][] = [
      [free.length > 0 && unopened.length > 0 ? 2 : 0, () => this.#openShared(this.#pick(unopened) as string, free)],
      [unopened.length > 0 ? 1 : 0, async () => this.#refuseShared(this.#pick(unopened) as string, [...taken].map(upper))],
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
    const retired = [
      ...this.#model.retired,
      ...this.#subset(
        names.filter((name) => !this.#model.retired.has(name)),
        0.05,
      ),
    ];
    const open = names.filter((name) => !retired.includes(name));
    // The private space declares few tables, so shared spaces often declare tables no space synced yet
    const synced = this.#subset(open, 0.25);
    const localOnly = this.#subset(
      open.filter((name) => !synced.includes(name)),
      0.4,
    );
    // Retired names resolve to the stored table whatever their case
    const spelled = retired.map((name) => (this.#random() < 0.5 ? name : upper(name)));
    const into = this.#random() < 0.2 ? this.#pick([synced, localOnly]) : undefined;
    const [misused, refusal] = (into && this.#misused(retired, [...synced, ...localOnly])) ?? [];
    if (misused) into?.push(misused);
    this.steps.push(`openPrivate(${owner}, [${synced}], local [${localOnly}], retired [${spelled}])`);
    const opening = () =>
      new Device(this.#storage, synced.map(table), { ...(owner !== None && { owner }), localOnly: localOnly.map(table), retired: spelled });
    if (into) {
      const before = this.#contents();
      expect(opening).toThrow(refusal);
      expect(this.#contents()).toEqual(before);
      return;
    }
    this.#device = opening();
    this.#model.openPrivate(owner, new Set(synced), new Set(localOnly), new Set(retired));
    this.#mirrors.set(P, this.#device.private);
  }

  /**
   * Schema of the app's objects and rows of every table, Syncline's own included: comparing bytes would see what a rolled back
   * transaction leaves in reused free pages, and a refused first open may leave Syncline's internal tables created but empty.
   */
  #contents() {
    const exec = (sql: string) => this.#storage.sql.exec(sql).toArray();
    const schema = exec("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
    const rows = schema
      .filter(({ type }) => type === 'table')
      .map(({ name }) => ({
        name,
        held: exec(`SELECT * FROM "${name}"`)
          .map((row) => JSON.stringify(row))
          .sort(),
      }))
      .filter(({ held }) => held.length > 0);
    return { schema: schema.filter(({ name }) => !String(name).startsWith('_syncline')), rows };
  }

  /** A name the private space refuses, and why: a retired one, one differing from a stored table only by case, or a non-table's. */
  #misused(retired: string[], declared: string[]) {
    const stored = names.filter((name) => !retired.includes(name) && !declared.includes(name));
    return this.#pick([
      ...retired.flatMap((name) => [name, upper(name)]).map((name) => [name, 'retired names']),
      ...[...stored.map(upper), 'shelf', 'NOTES'].map((name) => [name, 'is stored as']),
      ...['Shelf', 'notes'].map((name) => [name, `primary key of ${name} changed`]),
    ]) as [string, string];
  }

  /** Opens a shared space; failing ones declare a table the open rejects after the owner switch reset. */
  async #openShared(space: string, free: string[]) {
    const owner = this.#pick(users) as string;
    const declared = this.#subset(free, 0.5);
    if (declared.length === 0) declared.push(this.#pick(free) as string);
    const fails = this.#random() < 0.2;
    const tables: SQLiteTable[] = declared.map(table);
    // The reset wipes only the names declared exactly as stored, so a misspelled table is not among them
    let wiped = declared;
    if (fails) {
      const misuse = this.#pick(['retyped', 'case', 'other']);
      if (misuse === 'retyped') tables[0] = retyped(declared[0] as string);
      if (misuse === 'case') [tables[0], wiped] = [table(upper(declared[0] as string)), declared.slice(1)];
      // One misused object per session: a second space declaring it again would be refused as taken
      const other = this.#pick(otherNames.filter((name) => ![...this.#declared.values()].flat().includes(name.toLowerCase())));
      if (misuse === 'other' && other) tables.push(table(other));
    }
    this.steps.push(`openShared(${space}, [${tables.map(tableName)}], ${owner}${fails ? ', fails' : ''})`);
    const mirror = (this.#device as Device).shared(space, tables, owner === None ? undefined : owner);
    this.#declared.set(
      space,
      tables.map((declaration) => tableName(declaration).toLowerCase()),
    );
    if (fails) {
      await expect(mirror.opened()).rejects.toThrow();
    } else {
      await mirror.opened();
      this.#mirrors.set(space, mirror);
    }
    this.#model.openShared(space, new Set(wiped), owner, fails);
  }

  /** Declares a retired name or one another space or local-only use holds, under another case: refused before anything changes. */
  #refuseShared(space: string, taken: string[]) {
    const name = this.#pick([...[...this.#model.retired].flatMap((name) => [name, upper(name)]), ...taken]);
    if (name === undefined) return;
    this.steps.push(`refuseShared(${space}, [${name}])`);
    expect(() => (this.#device as Device).shared(space, [table(name)], this.#pick(users))).toThrow(
      /retired names|same name as an existing/,
    );
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

  /** The app drops a table and recreates it as its own (as declaring it would), so misused names still meet a stored table. */
  #externalDrop(name: string) {
    this.steps.push(`externalDrop(${name})`);
    this.#storage.sql.exec(`DROP TABLE IF EXISTS ${name}`);
    this.#storage.sql.exec(`CREATE TABLE ${name} (id TEXT PRIMARY KEY)`);
    this.#model.externalDrop(name);
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
        // Retiring drops synced tables
        const exists = this.#storage.sql.exec('SELECT 1 FROM pragma_table_list WHERE name = ?', name).toArray().length > 0;
        const ids = (exists ? this.#storage.sql.exec(`SELECT id FROM ${name}`).toArray() : []) as { id: string }[];
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
    await stepped(seed, simulation.steps, async () => {
      for (let step = 0; step < 60; step++) await simulation.step();
    });
  },
);
