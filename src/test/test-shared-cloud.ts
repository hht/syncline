import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Broadcast } from '../cloud/broadcast.ts';
import { type Bucket, type BucketRules, bucketId } from '../cloud/buckets.ts';
import { Fanout } from '../cloud/fanout.ts';
import type { Round } from '../cloud/shared.ts';
import { Space } from '../cloud/space.ts';
import type { Cookie } from '../common/protocol.ts';
import { parsePullRequest } from '../common/pull-url.ts';
import { subscribed } from './test-catalog.ts';
import type { Cloud, CloudEnd, Network } from './test-network.ts';
import { picker } from './test-skeleton.ts';
import { cloudStorage } from './test-storage.ts';

// Shared space cloud simulation: production shared Space and Broadcast shard, mock edge cache for HTTP pulls;
// backend writes, fanout rounds to shards (retrying dropped rounds with backoff), deploy rule updates, shard restarts
// and hibernated eviction, space rebuilds, token updates, and incremental bucket counting.

export const program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull(), title: text().notNull(), team: text() });
export const createProgram = 'CREATE TABLE program (id TEXT PRIMARY KEY, status TEXT NOT NULL, title TEXT NOT NULL, team TEXT)';

/** Deployed bucket rule variants: public filter alternates between published and featured; includes all and team-partitioned buckets. */
const definitions: BucketRules[] = [
  { public: { program: { where: "status = 'published'" } }, all: { program: {} }, team: { program: { by: ['team'] } } },
  { public: { program: { where: "status IN ('published', 'featured')" } }, all: { program: {} }, team: { program: { by: ['team'] } } },
];

/** Subscription configurations: adding, removing, or simultaneously adding and removing buckets. */
const buckets: Record<string, Bucket[]> = {
  public: [['public']],
  admin: [['all']],
  teamA: [['team', 'a']],
  publicA: [['public'], ['team', 'a']],
  teams: [
    ['team', 'a'],
    ['team', 'b'],
  ],
};
export const subscriptionNames = Object.keys(buckets);
/** Resolves bucket list and canonical subscription for given subscription name. */
export const bucketsOf = (name: string) => buckets[name] ?? [];
export const subscriptionOf = (name: string) => subscribed(...bucketsOf(name));

const keys = Array.from({ length: 12 }, (_, index) => `p${String(index).padStart(2, '0')}`);
const statuses = ['draft', 'published', 'featured'];
const teams = ['a', 'b', null];

/** Character limits for shard inline rounds and pull chunks; forces chunked pagination across full and incremental pulls. */
const inlineLimit = 300;
const chunkChars = 120;
const chunkRows = 2;
/** Commit floor threshold: truncates commit log after tens of writes. */
const commitFloor = 1_500;

export type Row = { id: string; status: string; title: string; team: string | null };

/** Computes visible rows for subscription under definition rules. */
export function rowsOf(storage: ReturnType<typeof cloudStorage>, definition: BucketRules, subscription: Bucket[]) {
  const conditions = subscription.map(([rule, ...params]) => {
    const member = definition[rule]?.program;
    if (!member) return '0';
    const by = (member.by ?? []).map((column, index) => `${column} = '${String(params[index])}'`);
    return `(${[member.where ?? '1', ...by].join(' AND ')})`;
  });
  const where = conditions.length > 0 ? conditions.join(' OR ') : '0';
  return storage.sql.exec(`SELECT id, status, title, team FROM program WHERE ${where} ORDER BY id`).toArray() as Row[];
}

export class SharedCloud {
  /** Shared space database storage: replaced on rebuild. */
  storage: ReturnType<typeof cloudStorage> = cloudStorage(createProgram);
  #deployed = 0;
  #space: Space;
  #broadcast: Broadcast<CloudEnd>;
  /** Fanout state machine to shards (production Fanout): instantiated per actor lifecycle. */
  #fanout!: Fanout;
  /** Head version acknowledged by all shards (persisted in space database in production); wiped on rebuild. */
  #saved: Cookie | null = null;
  /** Mock edge cache: maps URL and subscription to cached response and cache durability flag. */
  readonly #cache = new Map<string, { text: string; lasting: boolean }>();
  /** Calm period: faults stopped, notices deliver reliably, cache holds only intermediate chunks. */
  #calm = false;
  #titles = 0;
  /** Current subscription assigned to each device token. */
  readonly subscriptions: string[];
  readonly #network: Network;
  readonly #random: () => number;
  readonly #pick: ReturnType<typeof picker>;
  /** Mock Worker entrypoint: routes connections to broadcast shard and HTTP pulls through edge cache. */
  readonly endpoint: Cloud = {
    accept: (socket, target, expiresAt) =>
      this.#broadcast.accept(socket, parsePullRequest(target).cookie, expiresAt, this.#subscribedOf(target)),
    receive: (socket) => this.#broadcast.receive(socket),
    pull: (target) => this.#pull(target),
  };

  constructor(network: Network, random: () => number, subscriptions: string[]) {
    this.#network = network;
    this.#random = random;
    this.#pick = picker(random);
    this.subscriptions = subscriptions;
    this.#space = this.#open();
    this.#broadcast = this.#shard();
  }

  /** Transitions to calm state: delivers notices reliably, purges ephemeral cache entries, flushes lagging fanout rounds. */
  calm() {
    this.#calm = true;
    this.deliver();
  }

  definition() {
    return definitions[this.#deployed] as BucketRules;
  }

  /** Head commit of shared space. */
  head() {
    return this.#space.head();
  }

  /** Maps row bucket columns to identifier (c in model/TraceShared.tla): statuses x teams mapped to 1-9 (0 for absent). */
  bucketColumn(id: string) {
    const [row] = this.storage.sql.exec('SELECT status, team FROM program WHERE id = ?', id).toArray();
    if (!row) return 0;
    return statuses.indexOf(String(row.status)) * teams.length + teams.indexOf((row.team as string | null) ?? null) + 1;
  }

  /** Active incarnation of shared space. */
  incarnation() {
    return this.#space.round(0).incarnation;
  }

  /** Resolves subscription assigned to device index derived from URL path. */
  #subscribedOf(target: URL) {
    return subscriptionOf(this.subscriptions[Number(target.pathname.split('/').at(-1))] as string);
  }

  /** Updates token subscription: switches subscription; half of changes strictly widen subscribed buckets. */
  resubscribe(index: number) {
    const now = new Set(bucketsOf(this.subscriptions[index] as string).map((bucket) => JSON.stringify(bucket)));
    const wider = subscriptionNames.filter((name) => {
      const next = bucketsOf(name).map((bucket) => JSON.stringify(bucket));
      return next.length > now.size && [...now].every((bucket) => next.includes(bucket));
    });
    this.subscriptions[index] = (wider.length > 0 && this.#random() < 0.5 ? this.#pick(wider) : this.#pick(subscriptionNames)) as string;
  }

  /**
   * (Re)initializes shared space actor: checks rule evolution to record rescans;
   * instantiates fresh Fanout state machine starting from acknowledged head.
   */
  #open() {
    // Database size reported as 0: commitFloor acts as threshold, truncating every tens of writes.
    const storage = this.storage;
    const sql = { exec: (query: string, ...bindings: unknown[]) => storage.sql.exec(query, ...bindings), databaseSize: 0 };
    const space = new Space({ ...storage, sql }, [program], { shared: { buckets: this.definition(), chunkRows }, commitFloor });
    this.#fanout = new Fanout(
      {
        shards: ['shard'],
        head: () => space.head(),
        round: (from, head) => space.round(inlineLimit, from ?? head),
        send: (_shard, round) => this.#send(round),
        failed: () => undefined,
        confirmed: (head) => {
          this.#saved = head;
        },
      },
      this.#saved,
    );
    return space;
  }

  /** Sends fanout round to shard: simulates network drops and lost acknowledgments during active faults. */
  async #send(round: Round) {
    const fate = this.#calm ? 1 : this.#random();
    if (fate < 0.15) throw new Error('round delivery dropped');
    await this.#broadcast.notify(round);
    if (fate < 0.3) throw new Error('round delivered but ack dropped');
  }

  /** (Re)initializes broadcast shard: drops in-memory state and active connections. */
  #shard() {
    return new Broadcast(this.#network.sockets(), async () => this.#space.round(inlineLimit));
  }

  /**
   * HTTP pull via mock edge cache (models Cache-Control with subscription in cache key):
   * serves cached copy if present; responses computed before floor or from prior incarnations bypass cache.
   */
  #pull(target: URL) {
    const subscription = this.#subscribedOf(target);
    const key = `${subscription.sub} ${target.search}`;
    const cached = this.#cache.get(key);
    if (cached && (cached.lasting || !this.#calm) && this.#random() < 0.5) return cached.text;
    const request = parsePullRequest(target);
    const chunk = this.#space.pullShared(request, subscription, chunkChars);
    const text = JSON.stringify(chunk);
    const early = request.atLeast !== undefined && !('reset' in chunk) && (chunk.seen ?? 0) < request.atLeast;
    const otherIncarnation = request.incarnation !== undefined && chunk.incarnation !== request.incarnation;
    const lasting = request.cursor !== undefined && !('reset' in chunk) && !('cookie' in chunk);
    if (!early && !otherIncarnation) this.#cache.set(key, { text, lasting });
    return text;
  }

  /** Whether shards are lagging behind space head (requiring retry). */
  lagging() {
    return !this.#fanout.allAcked();
  }

  /** Delivers fanout round to shards. */
  deliver() {
    void this.#fanout.deliver();
  }

  /** Backend write: modifies or deletes a program row and triggers fanout delivery. */
  write() {
    const base = this.#space.head();
    const id = this.#pick(keys) as string;
    this.#titles += 1;
    const status = this.#pick(statuses) as string;
    const team = this.#pick(teams) ?? null;
    this.#space.mutate((tx) => {
      if (this.#random() < 0.2) tx.delete(program, { id });
      else tx.upsert(program, { id, status, title: `t${this.#titles}`, team });
    }, 0);
    if (this.#space.head().version === base.version) return;
    this.deliver();
  }

  /**
   * Shared space rebuild: fresh empty database, actor restart (emits head notice), re-imports initial rows;
   * resets version counter and incarnation nonce.
   */
  rebuild() {
    this.storage = cloudStorage(createProgram);
    this.#saved = null;
    this.#space = this.#open();
    this.deliver();
    const rows = Math.floor(this.#random() * 4);
    for (let row = 0; row < rows; row += 1) this.write();
  }

  /** Deploy: evolutes bucket rules and restarts actor; shard connections remain open. */
  deploy() {
    this.#deployed = (this.#deployed + 1) % definitions.length;
    this.#space = this.#open();
    this.deliver();
  }

  /** Incremental bucket row count maintenance step: steps 2 rows per call, interleaving with writes and deploys. */
  count() {
    this.#space.bucketRows?.step(2);
  }

  /** Log truncation step (Truncate in model): cookies or cursors behind floor receive reset. */
  truncate() {
    this.#space.truncate();
  }

  /** Verifies completed bucket counts against actual visible rows per bucket; throws on mismatch. */
  checkCounts() {
    const counts = this.#space.bucketRows;
    while (counts?.step(2));
    for (const bucket of new Set(Object.values(buckets).flat().map(bucketId))) {
      const counted = counts?.total([bucket]).total;
      const actual = rowsOf(this.storage, this.definition(), [JSON.parse(bucket) as Bucket]).length;
      if (counted !== actual) throw new Error(`bucket ${bucket} recorded count ${counted}, actual visible rows ${actual}`);
    }
  }

  restartShard() {
    this.#network.restart();
    this.#broadcast = this.#shard();
  }

  /** Shard evicted from memory while hibernating: in-memory state dropped while hibernated sockets survive. */
  evictShard() {
    this.#broadcast = this.#shard();
  }
}
