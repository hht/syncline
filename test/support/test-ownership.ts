// Reference state for ownership simulations: model/Ownership.tla translated action by action (same names, same order of
// effects), so the expected rows of each table come from the model rather than from the device implementation.
// Rows are abstracted to tags `space|user` (rows a space pulled for a user, or `local|user` for local-only writes).

/** No owner given (or none recorded yet). */
export const None = 'none';
/** The private space. */
export const P = 'P';
/** Source of local-only writes. */
export const Local = 'local';

const tagOf = (space: string, user: string) => `${space}|${user}`;
const userOf = (tag: string) => tag.slice(tag.indexOf('|') + 1);
const spaceOf = (tag: string) => tag.slice(0, tag.indexOf('|'));
const mine = (tag: string, owner: string) => [None, owner].includes(userOf(tag));

/** State of model/Ownership.tla, with its actions as methods and its invariants as checks that throw. */
export class Ownership {
  privOwner = None;
  readonly owner = new Map<string, string>();
  /** Owning space of each table, or None. */
  readonly record = new Map<string, string>();
  /** Table was synced at some point (`_syncline_columns` records it). */
  readonly synced = new Map<string, boolean>();
  /** Table carries `_extra` (lost when the app drops it). */
  readonly extra = new Map<string, boolean>();
  readonly content = new Map<string, Set<string>>();
  readonly cookie = new Map<string, boolean>();
  /** Space holds rows of the tables it does not declare (pulled since its last owner switch). */
  readonly unknown = new Map<string, boolean>();
  /** Tables each space declares in this session (empty if not opened). */
  readonly decl = new Map<string, Set<string>>();
  local = new Set<string>();
  phase: 'closed' | 'open' = 'closed';
  /** Retired tables (only ever grows). */
  retired = new Set<string>();
  /** Ghost: tables that held local-only rows and were then neither local-only nor synced. */
  readonly left = new Set<string>();
  readonly #tables: string[];
  readonly #shared: string[];

  constructor(tables: string[], shared: string[]) {
    this.#tables = tables;
    this.#shared = shared;
    for (const s of shared) this.owner.set(s, None);
    for (const t of tables) {
      this.record.set(t, None);
      this.synced.set(t, false);
      this.extra.set(t, false);
      this.content.set(t, new Set());
    }
    for (const s of [P, ...shared]) {
      this.cookie.set(s, false);
      this.unknown.set(s, false);
      this.decl.set(s, new Set());
    }
  }

  ownerOf(s: string) {
    return s === P ? this.privOwner : (this.owner.get(s) as string);
  }

  tag(s: string) {
    return tagOf(s, this.ownerOf(s));
  }

  /** Tables a space takes over on open: synced before but not recorded for it, or recreated since, or never synced but holding rows. */
  #returning(s: string, D: Set<string>, record: Map<string, string>, content: Map<string, Set<string>>) {
    return new Set(
      [...D].filter((t) => !(record.get(t) === s && this.extra.get(t)) && (this.synced.get(t) || (content.get(t) as Set<string>).size > 0)),
    );
  }

  /** Records after space s declares D: its old records dropped, D recorded for s. */
  #redeclared(s: string, D: Set<string>, record: Map<string, string>) {
    return new Map(this.#tables.map((t) => [t, D.has(t) ? s : record.get(t) === s ? None : (record.get(t) as string)]));
  }

  openPrivate(u: string, D: Set<string>, L: Set<string>, R: Set<string>) {
    // Only tables a space recorded: the others left sync earlier and may hold local-only writes since
    const gone = new Set([...R].filter((t) => this.record.get(t) !== None));
    const back = this.#returning(P, D, this.record, this.content);
    const foreign = new Set([...L].filter((t) => this.#shared.includes(this.record.get(t) as string)));
    const redeclared = this.#redeclared(P, D, this.record);
    const rec1 = new Map(this.#tables.map((t) => [t, L.has(t) || gone.has(t) ? None : (redeclared.get(t) as string)]));
    const wiped1 = new Map(this.#tables.map((t) => [t, back.has(t) || foreign.has(t) ? new Set<string>() : this.content.get(t)]));
    const isSwitch = u !== None && ![None, u].includes(this.privOwner);
    const who = u === None ? this.privOwner : u;
    const orphans = this.#tables.filter((t) => this.extra.get(t) && rec1.get(t) === None && !L.has(t));
    const cleared = new Set(isSwitch ? [...D, ...L, ...orphans] : []);
    const kept = !isSwitch && back.size === 0 && (this.cookie.get(P) as boolean);
    const restored = new Set([...D].filter((t) => !back.has(t) && this.unknown.get(P) && !this.synced.get(t)));
    const leaving = this.#tables.filter(
      (t) =>
        !D.has(t) && !L.has(t) && !this.extra.get(t) && [...(this.content.get(t) as Set<string>)].some((tag) => spaceOf(tag) === Local),
    );
    const stays = (flag: Map<string, boolean>, t: string) => (flag.get(t) && !gone.has(t)) || D.has(t);
    for (const t of this.#tables) {
      const rows = wiped1.get(t) as Set<string>;
      this.content.set(t, cleared.has(t) || gone.has(t) ? new Set() : restored.has(t) ? new Set([...rows, tagOf(P, who)]) : rows);
      this.record.set(t, rec1.get(t) as string);
      this.synced.set(t, stays(this.synced, t));
      this.extra.set(t, stays(this.extra, t));
    }
    this.cookie.set(P, kept);
    this.unknown.set(P, !isSwitch && (this.unknown.get(P) as boolean));
    this.privOwner = who;
    this.decl.set(P, new Set(D));
    this.local = new Set(L);
    this.retired = new Set(R);
    for (const t of leaving) this.left.add(t);
    this.phase = 'open';
  }

  /** Tables declared in this session by any space or for local-only use. */
  taken() {
    return new Set([...this.local, ...[...this.decl.values()].flatMap((tables) => [...tables])]);
  }

  /** The owner switch reset runs first, so it stands even if the open then fails. */
  openShared(s: string, D: Set<string>, o: string, fails: boolean) {
    const isSwitch = o !== None && ![None, o].includes(this.owner.get(s) as string);
    if (isSwitch) {
      for (const t of [...D, ...this.#tables.filter((t) => this.record.get(t) === s)]) {
        this.record.set(t, None);
        this.content.set(t, new Set());
      }
      this.cookie.set(s, false);
      this.unknown.set(s, false);
    }
    // The model tags rows with the owner before this open
    const tag = this.tag(s);
    if (o !== None) this.owner.set(s, o);
    if (!fails) this.#redeclareShared(s, D, tag);
  }

  #redeclareShared(s: string, D: Set<string>, tag: string) {
    const back = this.#returning(s, D, this.record, this.content);
    const kept = back.size === 0 && (this.cookie.get(s) as boolean);
    const dropped = new Set(this.#tables.filter((t) => this.record.get(t) === s && !D.has(t)));
    const restored = new Set([...D].filter((t) => !back.has(t) && this.unknown.get(s) && !this.synced.get(t)));
    const redeclared = this.#redeclared(s, D, this.record);
    for (const t of this.#tables) {
      const rows = this.content.get(t) as Set<string>;
      this.content.set(t, back.has(t) || dropped.has(t) ? new Set() : restored.has(t) ? new Set([...rows, tag]) : rows);
      this.record.set(t, redeclared.get(t) as string);
      this.synced.set(t, (this.synced.get(t) as boolean) || D.has(t));
      this.extra.set(t, (this.extra.get(t) as boolean) || D.has(t));
    }
    this.cookie.set(s, kept);
    this.decl.set(s, new Set(D));
  }

  pull(s: string) {
    if ((this.decl.get(s) as Set<string>).size === 0) throw new Error(`${s} declares no tables, so it cannot pull`);
    for (const t of this.decl.get(s) as Set<string>) {
      this.content.set(t, new Set([...(this.cookie.get(s) ? (this.content.get(t) as Set<string>) : []), this.tag(s)]));
    }
    this.cookie.set(s, true);
    this.unknown.set(s, true);
  }

  localWrite(t: string) {
    (this.content.get(t) as Set<string>).add(tagOf(Local, this.privOwner));
  }

  /** The app drops a table while the database is closed. */
  externalDrop(t: string) {
    this.content.set(t, new Set());
    this.extra.set(t, false);
  }

  close() {
    this.phase = 'closed';
    for (const s of this.decl.keys()) this.decl.set(s, new Set());
    this.local = new Set();
  }

  /** Throws unless rows (the reference's own by default) belong to the current owner of where they came from. */
  noLeak(content: Map<string, Set<string>> = this.content) {
    for (const [t, tags] of content) {
      for (const tag of tags) {
        const space = spaceOf(tag);
        const ok =
          space === P
            ? mine(tag, this.privOwner)
            : space === Local
              ? !this.local.has(t) || this.left.has(t) || mine(tag, this.privOwner)
              : mine(tag, this.ownerOf(space));
        if (!ok) throw new Error(`NoLeak violated: ${t} holds ${tag}`);
      }
    }
  }

  /** Throws unless an open space with a cookie holds exactly its own rows (the reference's by default) in every table it declares. */
  exact(content: Map<string, Set<string>> = this.content) {
    for (const [s, tables] of this.decl) {
      if (!this.cookie.get(s)) continue;
      for (const t of tables) {
        const tags = [...(content.get(t) as Set<string>)];
        if (tags.length === 0 || tags.some((tag) => spaceOf(tag) !== s || !mine(tag, this.ownerOf(s)))) {
          throw new Error(`Exact violated: ${t} declared by ${s} holds ${tags.join(', ') || 'nothing'}`);
        }
      }
    }
  }
}
