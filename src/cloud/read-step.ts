import type { Cookie, Op, Value } from '../common/protocol.ts';
import { opChars } from '../common/size.ts';
import { forgetTable, type Key, rowId } from '../tables/keys.ts';
import { type TableReads, wholeTable } from './batches.ts';
import type { Buckets, Lane, Subscription } from './buckets.ts';
import type { Commits, Entry } from './commits.ts';
import type { scopeOf } from './evolution.ts';
import type { Position, Range } from './position.ts';

// 读取器（Reader：起计划、核对带回的位置、编 next）的一次读：从位置起扫描、追尾巴、开下一轮，读满预算就停在那里。
// 照 model/Private.tla 的 HandlePull 与 FinalRows、Shared.tla 的 Chunks。
// 不该知道的：位置怎么编码、从哪起计划、块怎么回给设备

/** 一次至多读多少行（库里的行，含跳过的）、给出多少字符（改动的 JSON，opChars） */
export type Budget = { rows: number; chars: number };

/** 共用空间的设备看得见哪些行：buckets 是桶规则，subscription 是订阅，added 是订阅里新加的桶（落地时的订阅之外的）。私有空间不给，全看得见 */
export type Visible = { buckets: Buckets; subscription: Subscription; added: ReadonlySet<string> };

/** 扫着的一张表：cleared 是不用清（整份开头已清过、或只扫新加的桶），range 是要求重下的那一段，started 是已给过第一行（清过了） */
type TableScan = { table: string; cleared: boolean; range: Range | undefined; started: boolean };

/** 停在一路里：这张表、这一路的桶（私有空间没有）、扫到的主键（还没给这一路的行时没有） */
const laneAt = (table: string, { bucket }: Lane, after: Key | undefined) => ({
  table,
  ...(bucket === undefined ? {} : { bucket }),
  ...(after && { after }),
});

/** 一次读要的库：同步表怎么读、提交怎么分批读、范围表 */
type Store = { tables: TableReads; commits: Pick<Commits, 'after'>; entered: ReturnType<typeof scopeOf> };

/** 一次读：从 position 起扫描、追尾巴到 head（读开始时的最新一版：一次读是一次同步的调用，读的途中不会有新提交）、开下一轮，读满预算就停在 position */
export class Step {
  readonly #store: Store;
  readonly #head: Cookie;
  readonly #budget: Budget;
  readonly #ops: Op[];
  readonly #visible: Visible | undefined;
  /** 共用空间订阅里的桶 */
  readonly #subscribed: ReadonlySet<string>;
  /** 这一块已给过的行（标识见 rowId）：同一行只给一次 */
  readonly #sent = new Set<string>();
  /** 这一块读了库里几行：表的行、提交与其中的项，跳过的也算（对 Budget.rows） */
  #rows = 0;
  /** 这一块给出的改动共多少字符（opChars）、扫描给出了几行（下载进度用：同一行在几个桶里扫到几次就算几次） */
  chars: number;
  scanned = 0;
  /** 这一块前进过没有（给了一行、过了尾巴里的一项或一版）：没前进过不因预算停，每块至少前进一步 */
  #moved = false;
  position: Position;

  /** store 是读的库；position 是从哪读起，head 是读开始时的最新一版，ops 是已给的改动（整份开头的清空），visible 是共用空间的设备看得见哪些行 */
  constructor(
    store: Store,
    { position, head, budget, ops, visible }: { position: Position; head: Cookie; budget: Budget; ops: Op[]; visible: Visible | undefined },
  ) {
    this.#store = store;
    this.#head = head;
    this.position = position;
    this.#budget = budget;
    this.#ops = ops;
    this.#visible = visible;
    this.#subscribed = new Set(visible?.subscription);
    this.chars = ops.reduce((total, op) => total + opChars(op), 0);
  }

  /** 读到最新为 true，读满预算停下为 false */
  run() {
    for (;;) {
      if (!this.#scan() || !this.#tail()) return false;
      const { to } = this.position.round;
      if (this.#store.entered.scanSet(to, this.#head).length === 0) return true;
      const { ranges: _first, added: _added, ...rest } = this.position;
      this.position = { ...rest, round: { from: to, to: this.#head }, scan: { table: '' }, tail: { at: this.#head } };
      // 新一轮从下一块起：一块不跨轮（模型的 HandlePull 开下一轮的那一块停在新一轮的起点），只多一次请求，拉取途中又有表进入才会有
      if (this.#moved) return false;
    }
  }

  get #spent() {
    return this.#moved && (this.#rows >= this.#budget.rows || this.chars >= this.#budget.chars);
  }

  #give(op: Op, id: string) {
    if (this.#sent.has(id)) return;
    this.#sent.add(id);
    this.#ops.push(op);
    this.chars += opChars(op);
  }

  /**
   * 本轮的扫描：从 scan 停下的表、桶与主键接着扫；扫描集里的每张表先清掉（整份的第一轮由开头的清空代替）、再给它看得见的行，
   * 要求重下的表只清、只给要求的那一段（也在扫描集里的照扫描集整张扫），订阅里新加的桶只给桶里的行、不清（added，也在扫描集里的照扫描集扫）。扫完为 true
   */
  #scan() {
    const { scan, round, full, ranges = [], added } = this.position;
    if (!scan) return true;
    const cleared = round.from === null && full;
    const whole = this.#store.entered.scanSet(round.from, round.to);
    const extra = new Map(ranges.filter(({ table }) => !whole.includes(table)).map((range) => [range.table, range]));
    const fresh =
      this.#visible && added ? this.#store.tables.order().filter(({ table }) => !whole.includes(table) && !extra.has(table)) : [];
    const adding = new Set(fresh.map(({ table }) => table).filter((table) => this.#lanes(table, true).length > 0));
    for (const table of [...whole, ...extra.keys(), ...adding].sort().filter((name) => name >= scan.table)) {
      const resumed = table === scan.table ? scan : undefined;
      if (
        !this.#scanTable(table, resumed, {
          cleared: cleared || adding.has(table),
          range: extra.get(table),
          lanes: this.#lanes(table, adding.has(table)),
        })
      )
        return false;
    }
    const { scan: _done, ...scanned } = this.position;
    this.position = scanned;
    return true;
  }

  /** 扫一张表的各路：私有空间整张表一路；共用空间订阅里覆盖它的每个桶一路，added 时只扫订阅里新加的桶 */
  #lanes(table: string, added: boolean): Lane[] {
    const visible = this.#visible;
    if (!visible) return [wholeTable];
    return visible.buckets.lanes(table, visible.subscription, added ? visible.added : undefined);
  }

  /**
   * 扫一张表：从 resumed 停下的那一路、主键之后，一路路给它看得见的行。清掉（cleared：整份开头已清过、或只扫新加的桶）与第一行一起给，
   * 空表也清（设备上可能还有它离开之前的行）。range 是要求重下的那一段：只清、只给这一段，云端不同步的表只清。扫完为 true
   */
  #scanTable(table: string, resumed: Position['scan'], { lanes, ...rest }: { cleared: boolean; range: Range | undefined; lanes: Lane[] }) {
    // 停在一路中间或两路之间的已清过
    const state: TableScan = { table, ...rest, started: resumed?.after !== undefined || resumed?.bucket !== undefined };
    for (const lane of this.#store.tables.key(table) ? lanes : []) {
      if (lane.bucket !== undefined && resumed?.bucket !== undefined && lane.bucket < resumed.bucket) continue;
      if (!this.#scanLane(state, lane, lane.bucket === resumed?.bucket ? resumed?.after : undefined)) return false;
    }
    if (!state.started && this.#spent) return this.#stop({ table });
    this.#start(state);
    return true;
  }

  /** 扫一路：从主键 after 之后给它的行；读到下一行要给时才看预算，停在它前面。扫完为 true */
  #scanLane(state: TableScan, lane: Lane, from: Key | undefined) {
    const { table, range } = state;
    let after = from;
    for (const { rows: batch, read } of this.#store.tables.rows(table, after ?? range?.after, range?.until, lane)) {
      this.#rows += read;
      // 读进来没给的留给下一块（读行照样算上）
      for (const { key, row } of batch) {
        if (this.#spent) return this.#stop(state.started ? laneAt(table, lane, after) : { table });
        this.#start(state);
        this.#give({ op: 'put', table, key, row }, rowId(table, key));
        this.scanned += 1;
        this.#moved = true;
        after = key;
      }
    }
    return true;
  }

  /** 给这张表的第一行之前先清掉它（cleared 时不清） */
  #start(state: TableScan) {
    if (!state.started && !state.cleared) this.#clear(state.table, state.range);
    state.started = true;
  }

  #stop(scan: NonNullable<Position['scan']>) {
    this.position = { ...this.position, scan };
    return false;
  }

  /** 扫描先清一张表，或要求重下的那一段 */
  #clear(table: string, range: Range | undefined) {
    if (!range?.after && !range?.until) return this.#drop(table);
    forgetTable(this.#sent, table);
    const { after, until } = range as { after?: Record<string, Value>; until?: Record<string, Value> };
    const key = this.#store.tables.key(table) as string[];
    const op: Op = { op: 'drop', table, range: { key, ...(after && { after }), ...(until && { until }) } };
    this.#ops.push(op);
    this.chars += opChars(op);
  }

  /** 一张表清掉：这一块里之前给过的这张表的行作废 */
  #drop(table: string, columns?: string[]) {
    forgetTable(this.#sent, table);
    const op: Op = { op: 'drop', table, ...(columns && { columns }) };
    this.#ops.push(op);
    this.chars += opChars(op);
  }

  /** 尾巴里跳过的项：扫描集里的表在它进入的那一版及之前的（扫描已给了当前值） */
  #skipped(version: number, table: string, scanned: Set<string>) {
    return scanned.has(table) && version <= this.#store.entered.since(table);
  }

  /** 尾巴：从 tail 追到最新（head）；追到为 true */
  #tail() {
    const { round } = this.position;
    const scanned = new Set(this.#store.entered.scanSet(round.from, round.to));
    for (;;) {
      const { at, index = 0 } = this.position.tail;
      if (at.version >= this.#head.version) return true;
      const { commits, read } = this.#store.commits.after(at.version);
      this.#rows += read;
      if (commits.length === 0) return true;
      for (const [order, { cookie: version, keys }] of commits.entries())
        if (!this.#commit(version, keys, order === 0 ? index : 0, scanned)) return false;
    }
  }

  /** 过一版提交（前 skip 项已给过）：读到下一项、下一版时才看预算，停在它前面。过完为 true */
  #commit(version: Cookie, keys: Entry[], skip: number, scanned: Set<string>) {
    if (this.#spent && keys.length === 0) return false;
    for (let item = skip; item < keys.length; item += 1) {
      if (this.#spent) return false;
      this.#entry(keys[item] as Entry, version.version, scanned);
      this.#moved = true;
      this.position = { ...this.position, tail: { at: this.position.tail.at, index: item + 1 } };
    }
    this.#moved = true;
    this.position = { ...this.position, tail: { at: version } };
    return true;
  }

  /** 尾巴里的一项：离开同步的给 drop；改到的同步表的行，与设备有关的给当前看得见的值（看不见了给 del） */
  #entry(entry: Entry, version: number, scanned: Set<string>) {
    const [table, key, names] = entry;
    this.#rows += 1;
    if (this.#skipped(version, table, scanned)) return;
    if (key === null) return this.#drop(table, names);
    if (!this.#store.tables.key(table) || this.#sent.has(rowId(table, key))) return;
    // 共用空间只给改前或改后在订阅的桶里的（提交记录的这一项带着它们）
    if (this.#visible && !names?.some((bucket) => this.#subscribed.has(bucket))) return;
    const visible = this.#visible && { buckets: this.#visible.buckets, subscribed: this.#subscribed };
    this.#give(this.#store.tables.current(table, key, visible), rowId(table, key));
  }
}
